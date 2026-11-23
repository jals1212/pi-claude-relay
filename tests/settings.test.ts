import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, lstatSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettings, DEFAULT_NOTIFY, relayArgumentCompletions } from "../src/settings.ts";

test("missing file → both notifications on; load never throws", () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-settings-"));
	try {
		const s = createSettings(join(dir, "nope", "s.json"));
		assert.deepEqual(s.notify(), { warning: true, limit: true });
		assert.deepEqual(DEFAULT_NOTIFY, { warning: true, limit: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("set persists, the returned notify() is a copy, and a new store reads it back", () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-settings-"));
	try {
		const file = join(dir, "s.json");
		const s = createSettings(file);
		s.setNotify("limit", false);
		s.notify().limit = true; // mutating the copy must not change the store
		assert.deepEqual(s.notify(), { warning: true, limit: false });
		assert.deepEqual(createSettings(file).notify(), { warning: true, limit: false });
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { notify: { warning: true, limit: false } });
		writeFileSync(file, "garbage");
		assert.deepEqual(createSettings(file).notify(), { warning: true, limit: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

function inTmp(fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "relay-settings-"));
	try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("two stores on one file do not clobber each other's switch (re-read and merge before writing)", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	const a = createSettings(file);
	const b = createSettings(file); // both loaded the defaults
	assert.equal(a.setNotify("warning", false), true);
	assert.equal(b.setNotify("limit", false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { notify: { warning: false, limit: false } });
	assert.deepEqual(b.notify(), { warning: false, limit: false }, "the store adopts what is on disk");
	assert.deepEqual(createSettings(file).notify(), { warning: false, limit: false });
	// turning one back on keeps the other process's switch
	assert.equal(a.setNotify("warning", true), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { notify: { warning: true, limit: false } });
}));

test("a write keeps unrelated keys and survives a corrupt file", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	writeFileSync(file, JSON.stringify({ other: { keep: 1 }, notify: { warning: false, extra: "x" } }));
	const s = createSettings(file);
	assert.equal(s.setNotify("limit", false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: { keep: 1 }, notify: { warning: false, extra: "x", limit: false } });
	writeFileSync(file, "garbage");
	assert.equal(s.setNotify("warning", false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { notify: { warning: false, limit: true } });
}));

test("writes are atomic: private file, no temp files left behind, directory created", () => inTmp((dir) => {
	const file = join(dir, "nested", "s.json");
	const s = createSettings(file);
	assert.equal(s.setNotify("warning", false), true);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(join(dir, "nested")), ["s.json"]);
	// an existing loose file ends up private, and replacing it is a rename (new inode), not an in-place rewrite
	chmodSync(file, 0o644);
	const before = statSync(file).ino;
	assert.equal(s.setNotify("limit", false), true);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.notEqual(statSync(file).ino, before);
	assert.deepEqual(readdirSync(join(dir, "nested")), ["s.json"]);
}));

test("a failed write leaves no temp file and reports false", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	mkdirSync(file); // the target is a directory: the rename must fail
	const s = createSettings(file);
	assert.equal(s.setNotify("limit", false), false);
	assert.deepEqual(readdirSync(dir), ["s.json"]);
	assert.deepEqual(s.notify(), { warning: true, limit: false }, "applies in memory until restart");
}));

test("a symlinked settings file is never written through; the write is refused", () => inTmp((dir) => {
	const target = join(dir, "target.json");
	writeFileSync(target, JSON.stringify({ notify: { warning: true, limit: true } }));
	const file = join(dir, "s.json");
	symlinkSync(target, file);
	const s = createSettings(file);
	assert.equal(s.setNotify("limit", false), false);
	assert.equal(lstatSync(file).isSymbolicLink(), true, "the link is left alone");
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { notify: { warning: true, limit: true } }, "the target is untouched");
	assert.deepEqual(readdirSync(dir).sort(), ["s.json", "target.json"]);
	assert.deepEqual(s.notify(), { warning: true, limit: false });
}));

test("timing is off by default; a missing, corrupt or non-boolean field means off", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	assert.equal(createSettings(file).timing(), false);
	writeFileSync(file, "garbage");
	assert.equal(createSettings(file).timing(), false);
	for (const v of ["on", 1, null, "true", {}]) { writeFileSync(file, JSON.stringify({ timing: v })); assert.equal(createSettings(file).timing(), false, String(v)); }
	writeFileSync(file, JSON.stringify({ timing: true }));
	assert.equal(createSettings(file).timing(), true);
}));

test("setTiming persists, is read back by a new store, and keeps notify and unrelated keys; setNotify keeps timing", () => inTmp((dir) => {
	const file = join(dir, "nested", "s.json");
	writeFileSync(join(dir, "other.json"), "{}");
	const s = createSettings(file);
	assert.equal(s.setTiming(true), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { timing: true });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(createSettings(file).timing(), true);
	assert.equal(s.setNotify("limit", false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { timing: true, notify: { warning: true, limit: false } });
	assert.equal(s.setTiming(false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { timing: false, notify: { warning: true, limit: false } });
	assert.deepEqual(createSettings(file).notify(), { warning: true, limit: false });
	writeFileSync(file, JSON.stringify({ other: { keep: 1 }, notify: { warning: false, limit: true } }));
	assert.equal(s.setTiming(true), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: { keep: 1 }, notify: { warning: false, limit: true }, timing: true });
}));

test("a failed timing write reports false and applies in memory until restart", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	mkdirSync(file);
	const s = createSettings(file);
	assert.equal(s.setTiming(true), false);
	assert.equal(s.timing(), true);
	assert.deepEqual(readdirSync(dir), ["s.json"]);
}));

test("a later successful save of one switch does not undo an unsaved change of another", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	const s = createSettings(file);
	chmodSync(dir, 0o500); // the timing save cannot write
	try { assert.equal(s.setTiming(true), false); } finally { chmodSync(dir, 0o700); }
	assert.equal(s.setNotify("warning", false), true);
	assert.equal(s.timing(), true, "the unsaved timing change still applies until restart");
	assert.deepEqual(s.notify(), { warning: false, limit: true });
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(saved.timing, undefined, "only the switch that was saved reaches the file");
	assert.deepEqual(saved.notify, { warning: false, limit: true });

	chmodSync(dir, 0o500); // and the other way round
	try { assert.equal(s.setNotify("limit", false), false); } finally { chmodSync(dir, 0o700); }
	assert.equal(s.setTiming(false), true);
	assert.deepEqual(s.notify(), { warning: false, limit: false });
	assert.equal(s.timing(), false);
}));

test("completions offer timing and its on/off", () => {
	assert.deepEqual(relayArgumentCompletions("")?.map((i) => i.value), ["notify", "stats", "timing"]);
	assert.deepEqual(relayArgumentCompletions("ti")?.map((i) => i.value), ["timing"]);
	assert.deepEqual(relayArgumentCompletions("timing ")?.map((i) => i.value), ["timing on", "timing off"]);
	assert.equal(relayArgumentCompletions("timing on "), null);
});
