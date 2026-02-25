import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	countSessionFiles,
	createLinkTransaction,
	formatAge,
	formatSessionOption,
	getPathKind,
	listFolderChoices,
	normalizeSnippet,
	safeRemovePath,
	truncate,
} from "../extensions/link-sessions-core.ts";

function createTempDir(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "link-sessions-test-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function symlinkDir(target: string, linkPath: string): void {
	const symlinkType = process.platform === "win32" ? "junction" : "dir";
	symlinkSync(target, linkPath, symlinkType);
}

function writeSessionFile(folder: string, fileName: string, contents: string): void {
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, fileName), contents);
}

function assertFileContents(path: string, expected: string): void {
	assert.equal(readFileSync(path, "utf8"), expected);
}

test("countSessionFiles only counts .jsonl files", (t) => {
	const root = createTempDir(t);
	const folder = join(root, "sessions");
	mkdirSync(folder, { recursive: true });

	writeFileSync(join(folder, "a.jsonl"), "{}");
	writeFileSync(join(folder, "b.jsonl"), "{}");
	writeFileSync(join(folder, "notes.txt"), "ignore");

	assert.equal(countSessionFiles(folder), 2);
});

test("listFolderChoices includes directories and directory symlinks, current first", (t) => {
	const root = createTempDir(t);

	const current = join(root, "bbb");
	const other = join(root, "aaa");
	mkdirSync(current, { recursive: true });
	mkdirSync(other, { recursive: true });
	writeFileSync(join(current, "one.jsonl"), "{}");
	writeFileSync(join(other, "x.jsonl"), "{}");
	writeFileSync(join(other, "y.jsonl"), "{}");
	writeFileSync(join(root, "not-a-dir.txt"), "x");

	symlinkDir(other, join(root, "link-aaa"));

	const choices = listFolderChoices(root, "bbb");

	assert.deepEqual(
		choices.map((choice) => choice.name),
		["bbb", "aaa", "link-aaa"],
	);
	assert.equal(choices[0]?.isCurrent, true);
	assert.equal(choices[0]?.sessionCount, 1);
	assert.equal(choices[1]?.sessionCount, 2);
	assert.equal(choices[2]?.sessionCount, 2);
});

test("createLinkTransaction creates symlink and commit removes backup", (t) => {
	const root = createTempDir(t);
	const current = join(root, "current");
	const target = join(root, "target");

	mkdirSync(current, { recursive: true });
	writeFileSync(join(current, "old.jsonl"), "old");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "new.jsonl"), "new");

	const tx = createLinkTransaction(current, target);
	assert.equal(getPathKind(current), "symlink");
	assert.equal(readFileSync(join(current, "new.jsonl"), "utf8"), "new");

	const listBackups = () => readdirSync(root).filter((name) => name.startsWith("current.bak-"));
	assert.equal(listBackups().length, 1);

	tx.commit();

	assert.equal(listBackups().length, 0);
	assert.equal(lstatSync(current).isSymbolicLink(), true);
});

test("createLinkTransaction rollback restores original directory", (t) => {
	const root = createTempDir(t);
	const current = join(root, "current");
	const target = join(root, "target");

	mkdirSync(current, { recursive: true });
	writeFileSync(join(current, "original.jsonl"), "original");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "new.jsonl"), "new");

	const tx = createLinkTransaction(current, target);
	assert.equal(getPathKind(current), "symlink");

	tx.rollback();

	assert.equal(getPathKind(current), "directory");
	assert.equal(statSync(current).isDirectory(), true);
	assert.equal(readFileSync(join(current, "original.jsonl"), "utf8"), "original");
	assert.equal(readdirSync(root).some((name) => name.startsWith("current.bak-")), false);
});

test("createLinkTransaction commit only replaces current folder and keeps other session folders intact", (t) => {
	const root = createTempDir(t);
	const current = join(root, "cwd-current");
	const target = join(root, "cwd-target");
	const otherA = join(root, "cwd-other-a");
	const otherB = join(root, "cwd-other-b");

	writeSessionFile(current, "current.jsonl", "current-session");
	writeSessionFile(target, "target.jsonl", "target-session");
	writeSessionFile(otherA, "a.jsonl", "keep-a");
	writeSessionFile(otherB, "b.jsonl", "keep-b");

	const beforeNames = readdirSync(root).sort();

	const tx = createLinkTransaction(current, target);
	tx.commit();

	assert.equal(getPathKind(current), "symlink");
	assertFileContents(join(current, "target.jsonl"), "target-session");
	assertFileContents(join(otherA, "a.jsonl"), "keep-a");
	assertFileContents(join(otherB, "b.jsonl"), "keep-b");
	assert.deepEqual(readdirSync(root).sort(), beforeNames);
});

test("createLinkTransaction rollback restores current folder without touching other session folders", (t) => {
	const root = createTempDir(t);
	const current = join(root, "cwd-current");
	const target = join(root, "cwd-target");
	const other = join(root, "cwd-unrelated");

	writeSessionFile(current, "current.jsonl", "current-session");
	writeSessionFile(target, "target.jsonl", "target-session");
	writeSessionFile(other, "other.jsonl", "other-session");

	const tx = createLinkTransaction(current, target);
	assert.equal(getPathKind(current), "symlink");

	tx.rollback();

	assert.equal(getPathKind(current), "directory");
	assertFileContents(join(current, "current.jsonl"), "current-session");
	assertFileContents(join(target, "target.jsonl"), "target-session");
	assertFileContents(join(other, "other.jsonl"), "other-session");
	assert.equal(readdirSync(root).some((name) => name.startsWith("cwd-current.bak-")), false);
});

test("createLinkTransaction commit from symlink current keeps previous target and unrelated folders intact", (t) => {
	const root = createTempDir(t);
	const oldTarget = join(root, "cwd-old-target");
	const newTarget = join(root, "cwd-new-target");
	const current = join(root, "cwd-current");
	const other = join(root, "cwd-other");

	writeSessionFile(oldTarget, "old.jsonl", "old-target-session");
	writeSessionFile(newTarget, "new.jsonl", "new-target-session");
	writeSessionFile(other, "other.jsonl", "other-session");
	symlinkDir(oldTarget, current);

	const tx = createLinkTransaction(current, newTarget);
	tx.commit();

	assert.equal(getPathKind(current), "symlink");
	assertFileContents(join(current, "new.jsonl"), "new-target-session");
	assertFileContents(join(oldTarget, "old.jsonl"), "old-target-session");
	assertFileContents(join(other, "other.jsonl"), "other-session");
	assert.equal(readdirSync(root).some((name) => name.startsWith("cwd-current.bak-")), false);
});

test("createLinkTransaction rollback from symlink current restores previous mapping and keeps other folders intact", (t) => {
	const root = createTempDir(t);
	const oldTarget = join(root, "cwd-old-target");
	const newTarget = join(root, "cwd-new-target");
	const current = join(root, "cwd-current");
	const other = join(root, "cwd-other");

	writeSessionFile(oldTarget, "old.jsonl", "old-target-session");
	writeSessionFile(newTarget, "new.jsonl", "new-target-session");
	writeSessionFile(other, "other.jsonl", "other-session");
	symlinkDir(oldTarget, current);

	const tx = createLinkTransaction(current, newTarget);
	tx.rollback();

	assert.equal(getPathKind(current), "symlink");
	assertFileContents(join(current, "old.jsonl"), "old-target-session");
	assertFileContents(join(oldTarget, "old.jsonl"), "old-target-session");
	assertFileContents(join(newTarget, "new.jsonl"), "new-target-session");
	assertFileContents(join(other, "other.jsonl"), "other-session");
	assert.equal(readdirSync(root).some((name) => name.startsWith("cwd-current.bak-")), false);
});

test("createLinkTransaction from missing current path does not touch unrelated session folders", (t) => {
	const root = createTempDir(t);
	const currentMissing = join(root, "cwd-current");
	const target = join(root, "cwd-target");
	const other = join(root, "cwd-other");

	writeSessionFile(target, "target.jsonl", "target-session");
	writeSessionFile(other, "other.jsonl", "other-session");

	const beforeOtherContents = readFileSync(join(other, "other.jsonl"), "utf8");

	const tx = createLinkTransaction(currentMissing, target);
	tx.commit();

	assert.equal(getPathKind(currentMissing), "symlink");
	assertFileContents(join(currentMissing, "target.jsonl"), "target-session");
	assertFileContents(join(other, "other.jsonl"), beforeOtherContents);
});

test("safeRemovePath removes symlink path without deleting the linked target folder", (t) => {
	const root = createTempDir(t);
	const target = join(root, "target");
	const linkPath = join(root, "link");
	const unrelated = join(root, "unrelated");

	writeSessionFile(target, "target.jsonl", "target-session");
	writeSessionFile(unrelated, "unrelated.jsonl", "unrelated-session");
	symlinkDir(target, linkPath);

	safeRemovePath(linkPath);

	assert.equal(getPathKind(linkPath), "missing");
	assertFileContents(join(target, "target.jsonl"), "target-session");
	assertFileContents(join(unrelated, "unrelated.jsonl"), "unrelated-session");
});

test("createLinkTransaction rejects invalid target and non-directory current path", (t) => {
	const root = createTempDir(t);
	const currentFile = join(root, "current-file");
	const targetDir = join(root, "target");
	mkdirSync(targetDir, { recursive: true });
	writeFileSync(currentFile, "x");

	assert.throws(
		() => createLinkTransaction(join(root, "missing-current"), join(root, "missing-target")),
		/Target is not a directory/,
	);

	assert.throws(
		() => createLinkTransaction(currentFile, targetDir),
		/Refusing to overwrite non-directory\/non-symlink path/,
	);
});

test("text helpers normalize, truncate, age and format session options", () => {
	assert.equal(normalizeSnippet("  hello\n\tworld   "), "hello world");
	assert.equal(truncate("abcd", 4), "abcd");
	assert.equal(truncate("abcdef", 4), "abc…");

	const now = Date.now();
	assert.equal(formatAge(new Date(now - 30_000)), "now");
	assert.equal(formatAge(new Date(now - 5 * 60_000)), "5m");
	assert.equal(formatAge(new Date(now - 2 * 3_600_000)), "2h");

	const option = formatSessionOption(
		{
			name: "Hello\nthere",
			messageCount: 1,
			modified: new Date(now - (6 * 60_000 + 2_000)),
		},
		0,
	);

	assert.match(option, /^1\. Hello there — 1 msg — 6m$/);
});
