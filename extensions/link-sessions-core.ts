import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";

export interface FolderChoice {
	name: string;
	path: string;
	sessionCount: number;
	isCurrent: boolean;
}

export type PathKind = "missing" | "symlink" | "directory" | "other";

export interface LinkTransaction {
	rollback(): void;
	commit(): void;
}

export interface SessionPreviewInfo {
	name?: string | null;
	firstMessage?: string | null;
	messageCount: number;
	modified: Date;
}

export function isDirectoryLike(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function getPathKind(path: string): PathKind {
	if (!existsSync(path)) return "missing";

	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) return "symlink";
		if (stats.isDirectory()) return "directory";
		return "other";
	} catch {
		return "other";
	}
}

export function countSessionFiles(dirPath: string): number {
	try {
		return readdirSync(dirPath).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

export function truncate(text: string, maxLength = 72): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1)}…`;
}

export function formatAge(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	const mins = Math.floor(diffMs / 60_000);
	const hours = Math.floor(diffMs / 3_600_000);
	const days = Math.floor(diffMs / 86_400_000);

	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

export function normalizeSnippet(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export function shortenPath(path: string, homeDir = os.homedir()): string {
	if (path.startsWith(homeDir)) {
		return `~${path.slice(homeDir.length)}`;
	}
	return path;
}

export function formatDateTime(date: Date): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	const hh = String(date.getHours()).padStart(2, "0");
	const mi = String(date.getMinutes()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function makeUniqueBackupPath(path: string): string {
	const stamp = Date.now();
	let index = 0;
	let candidate = `${path}.bak-${stamp}`;
	while (existsSync(candidate)) {
		index += 1;
		candidate = `${path}.bak-${stamp}-${index}`;
	}
	return candidate;
}

export function safeRemovePath(path: string): void {
	if (!existsSync(path)) return;

	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) {
			rmSync(path, { force: true });
			return;
		}
		rmSync(path, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

export function listFolderChoices(sessionsRoot: string, currentFolderName: string): FolderChoice[] {
	if (!existsSync(sessionsRoot)) return [];

	const entries = readdirSync(sessionsRoot, { withFileTypes: true });
	const choices: FolderChoice[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

		const folderPath = join(sessionsRoot, entry.name);
		if (!isDirectoryLike(folderPath)) continue;

		choices.push({
			name: entry.name,
			path: folderPath,
			sessionCount: countSessionFiles(folderPath),
			isCurrent: entry.name === currentFolderName,
		});
	}

	choices.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return choices;
}

export function createLinkTransaction(currentSessionDir: string, targetPath: string): LinkTransaction {
	const resolvedCurrentDir = resolve(currentSessionDir);
	const resolvedTargetPath = resolve(targetPath);

	if (!isDirectoryLike(resolvedTargetPath)) {
		throw new Error(`Target is not a directory: ${resolvedTargetPath}`);
	}

	const currentKind = getPathKind(resolvedCurrentDir);
	if (currentKind === "other") {
		throw new Error(`Refusing to overwrite non-directory/non-symlink path: ${resolvedCurrentDir}`);
	}

	mkdirSync(dirname(resolvedCurrentDir), { recursive: true });

	let backupPath: string | undefined;
	if (currentKind !== "missing") {
		backupPath = makeUniqueBackupPath(resolvedCurrentDir);
		renameSync(resolvedCurrentDir, backupPath);
	}

	try {
		const symlinkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(resolvedTargetPath, resolvedCurrentDir, symlinkType);
	} catch (err) {
		if (backupPath && existsSync(backupPath)) {
			try {
				renameSync(backupPath, resolvedCurrentDir);
			} catch {
				// ignore
			}
		}
		throw err;
	}

	let closed = false;

	return {
		rollback() {
			if (closed) return;
			closed = true;

			safeRemovePath(resolvedCurrentDir);
			if (backupPath && existsSync(backupPath)) {
				renameSync(backupPath, resolvedCurrentDir);
			}
		},
		commit() {
			if (closed) return;
			closed = true;

			if (backupPath && existsSync(backupPath)) {
				safeRemovePath(backupPath);
			}
		},
	};
}

export function formatSessionOption(session: SessionPreviewInfo, index: number): string {
	const title = normalizeSnippet(session.name ?? session.firstMessage ?? "(untitled)");
	const messageText = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;
	const age = formatAge(session.modified);
	return `${index + 1}. ${truncate(title)} — ${messageText} — ${age}`;
}
