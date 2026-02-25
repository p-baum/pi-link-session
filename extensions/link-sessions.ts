import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type SessionInfo } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@mariozechner/pi-tui";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	type FolderChoice,
	type LinkTransaction,
	countSessionFiles,
	createLinkTransaction,
	formatDateTime,
	formatSessionOption,
	getPathKind,
	listFolderChoices,
	normalizeSnippet,
	shortenPath,
	truncate,
} from "./link-sessions-core.ts";

async function buildFolderPreviewText(folder: FolderChoice, cwd: string): Promise<string> {
	const sessions = await SessionManager.list(cwd, folder.path);
	const lines: string[] = [];
	lines.push(`folder: ${folder.name}${folder.isCurrent ? " (current)" : ""}`);
	lines.push(`sessions: ${sessions.length}`);
	if (sessions[0]?.cwd) {
		lines.push(`cwd: ${shortenPath(sessions[0].cwd)}`);
	}

	if (sessions.length === 0) {
		lines.push("", "(no sessions in this folder)");
		return lines.join("\n");
	}

	const lastSessions = sessions.slice(0, 5);
	lines.push("", `Last ${lastSessions.length} sessions:`);
	for (const session of lastSessions) {
		const title = truncate(normalizeSnippet(session.name ?? session.firstMessage ?? "(untitled)"), 100);
		lines.push(`- ${formatDateTime(session.modified)}  ${title}`);
	}

	return lines.join("\n");
}

async function selectFolderWithPreview(
	ctx: ExtensionCommandContext,
	folderChoices: FolderChoice[],
): Promise<FolderChoice | undefined> {
	const items: SelectItem[] = folderChoices.map((choice) => ({
		value: choice.name,
		label: choice.isCurrent ? `${choice.name} (current)` : choice.name,
		description: `${choice.sessionCount} session${choice.sessionCount === 1 ? "" : "s"}`,
	}));

	const selectedFolderName = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Choose session folder")), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		container.addChild(selectList);
		container.addChild(new Spacer(1));

		container.addChild(new Text(theme.fg("accent", theme.bold("Preview: last 5 sessions")), 1, 0));
		const previewText = new Text(theme.fg("muted", "(loading preview...)"), 1, 0);
		container.addChild(previewText);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

		const previewCache = new Map<string, string>();
		let previewRequestId = 0;

		const setPreviewText = (text: string, color: "muted" | "warning" = "muted") => {
			previewText.setText(color === "warning" ? theme.fg("warning", text) : theme.fg("muted", text));
		};

		const loadPreview = (folderName: string) => {
			const cached = previewCache.get(folderName);
			if (cached) {
				setPreviewText(cached);
				tui.requestRender();
				return;
			}

			const reqId = ++previewRequestId;
			setPreviewText("(loading preview...)");
			tui.requestRender();

			const folder = folderChoices.find((f) => f.name === folderName);
			if (!folder) {
				setPreviewText("(invalid folder)", "warning");
				tui.requestRender();
				return;
			}

			void buildFolderPreviewText(folder, ctx.cwd)
				.then((text) => {
					previewCache.set(folderName, text);
					if (reqId !== previewRequestId) return;
					setPreviewText(text);
					tui.requestRender();
				})
				.catch((err) => {
					const message = err instanceof Error ? err.message : String(err);
					const text = `(failed to load preview) ${message}`;
					previewCache.set(folderName, text);
					if (reqId !== previewRequestId) return;
					setPreviewText(text, "warning");
					tui.requestRender();
				});
		};

		selectList.onSelectionChange = (item) => loadPreview(item.value);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		const initial = selectList.getSelectedItem();
		if (initial) {
			loadPreview(initial.value);
		} else {
			setPreviewText("(no folders)");
		}

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (!selectedFolderName) return undefined;
	return folderChoices.find((choice) => choice.name === selectedFolderName);
}

async function selectSessionToResume(sessions: SessionInfo[], ctx: ExtensionCommandContext): Promise<SessionInfo | undefined> {
	const options: string[] = [];
	const byOption = new Map<string, SessionInfo>();

	for (let i = 0; i < sessions.length; i += 1) {
		const option = formatSessionOption(sessions[i], i);
		options.push(option);
		byOption.set(option, sessions[i]);
	}

	const selected = await ctx.ui.select("Select session to resume", options);
	if (!selected) return undefined;

	return byOption.get(selected);
}

export default function linkSessionsExtension(pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("Waiting for current response to finish...", "info");
			await ctx.waitForIdle();
		}

		const currentSessionDir = ctx.sessionManager.getSessionDir();
		if (!currentSessionDir) {
			ctx.ui.notify("Current session is ephemeral (--no-session). Cannot Link folders.", "error");
			return;
		}

		const currentFolderName = basename(currentSessionDir);
		const sessionsRoot = dirname(currentSessionDir);
		mkdirSync(sessionsRoot, { recursive: true });

		const folderChoices = listFolderChoices(sessionsRoot, currentFolderName);
		if (folderChoices.length === 0) {
			ctx.ui.notify("No session folders found.", "warning");
			return;
		}

		const selectedFolder = await selectFolderWithPreview(ctx, folderChoices);
		if (!selectedFolder) {
			ctx.ui.notify("Link sessions cancelled.", "info");
			return;
		}

		let transaction: LinkTransaction | undefined;
		const linkNeeded = !selectedFolder.isCurrent;

		if (linkNeeded) {
			const currentKind = getPathKind(currentSessionDir);
			if (currentKind === "other") {
				ctx.ui.notify("Refusing to link: current session path is not a directory or symlink.", "error");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Link sessions?",
				`Replace ${currentFolderName} with a symlink to ${selectedFolder.name}?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Link cancelled.", "info");
				return;
			}

			if (currentKind === "directory") {
				const sessionCount = countSessionFiles(currentSessionDir);
				if (sessionCount > 1) {
					const destructiveConfirmed = await ctx.ui.confirm(
						"Permanent deletion warning",
						`The current session folder (${currentFolderName}) is not a symlink and contains ${sessionCount} sessions. Continuing will permanently delete these existing sessions. Continue?`,
					);
					if (!destructiveConfirmed) {
						ctx.ui.notify("Link cancelled. No files were changed.", "info");
						return;
					}
				}
			}

			try {
				transaction = createLinkTransaction(currentSessionDir, selectedFolder.path);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to link sessions: ${message}`, "error");
				return;
			}
		}

		try {
			const sessions = await SessionManager.list(ctx.cwd, currentSessionDir);
			const revertedSuffix = linkNeeded ? " Changes reverted." : "";
			if (sessions.length === 0) {
				const createNew = await ctx.ui.confirm(
					"No sessions found",
					"Create a new session in this folder now?",
				);

				if (!createNew) {
					transaction?.rollback();
					ctx.ui.notify(`No session selected.${revertedSuffix}`, "info");
					return;
				}

				const result = await ctx.newSession();
				if (result.cancelled) {
					transaction?.rollback();
					ctx.ui.notify(`Session creation cancelled.${revertedSuffix}`, "info");
					return;
				}

				transaction?.commit();
				ctx.ui.notify(
					linkNeeded ? "Sessions linked. Started a new session." : "Started a new session.",
					"info",
				);
				return;
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			const selectedSession = await selectSessionToResume(sessions, ctx);
			if (!selectedSession) {
				transaction?.rollback();
				ctx.ui.notify(`No session selected.${revertedSuffix}`, "info");
				return;
			}

			const switchResult = await ctx.switchSession(selectedSession.path);
			if (switchResult.cancelled) {
				transaction?.rollback();
				ctx.ui.notify(`Session switch cancelled.${revertedSuffix}`, "info");
				return;
			}

			transaction?.commit();
			ctx.ui.notify(
				linkNeeded
					? `Linked to ${selectedFolder.name} and switched session.`
					: "Switched session.",
				"info",
			);
		} catch (err) {
			transaction?.rollback();
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to complete session switch: ${message}`, "error");
		}
	};

	pi.registerCommand("link-sessions", {
		description: "Link sessions from another path",
		handler,
	});
}
