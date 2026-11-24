import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, lstatSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_USAGE, createSettings, DEFAULT_NOTIFY, relayArgumentCompletions, runRelayCommand } from "../src/settings.ts";

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
	assert.deepEqual(relayArgumentCompletions("")?.map((i) => i.value), ["notify", "stats", "timing", "status", "reset", "label"]);
	assert.deepEqual(relayArgumentCompletions("ti")?.map((i) => i.value), ["timing"]);
	assert.deepEqual(relayArgumentCompletions("timing ")?.map((i) => i.value), ["timing on", "timing off"]);
	assert.equal(relayArgumentCompletions("timing on "), null);
});

test("usage status is on by default; a missing, corrupt or non-boolean field means on", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	assert.equal(createSettings(file).usageStatus(), true);
	writeFileSync(file, "garbage");
	assert.equal(createSettings(file).usageStatus(), true);
	for (const v of ["off", 0, null, "false", [], { usage: "no" }, {}]) { writeFileSync(file, JSON.stringify({ status: v })); assert.equal(createSettings(file).usageStatus(), true, JSON.stringify(v)); }
	writeFileSync(file, JSON.stringify({ status: { usage: false } }));
	assert.equal(createSettings(file).usageStatus(), false);
}));

test("setUsageStatus persists under status.usage, is read back, and keeps notify, timing, unknown keys and unknown status keys", () => inTmp((dir) => {
	const file = join(dir, "nested", "s.json");
	const s = createSettings(file);
	assert.equal(s.setUsageStatus(false), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: { usage: false } });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(createSettings(file).usageStatus(), false);
	assert.equal(s.setNotify("limit", false), true);
	assert.equal(s.setTiming(true), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: { usage: false }, notify: { warning: true, limit: false }, timing: true });
	writeFileSync(file, JSON.stringify({ other: { keep: 1 }, status: { future: "x" }, notify: { warning: false, limit: true }, timing: true }));
	assert.equal(s.setUsageStatus(true), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: { keep: 1 }, status: { future: "x", usage: true }, notify: { warning: false, limit: true }, timing: true });
	assert.equal(s.usageStatus(), true);
}));

test("a failed usage-status write reports false, keeps the in-memory value, and does not disturb another unsaved switch", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	mkdirSync(file);
	const s = createSettings(file);
	assert.equal(s.setUsageStatus(false), false);
	assert.equal(s.usageStatus(), false);
	assert.deepEqual(readdirSync(dir), ["s.json"]);
	const file2 = join(dir, "t.json");
	const t = createSettings(file2);
	chmodSync(dir, 0o500);
	try { assert.equal(t.setUsageStatus(false), false); } finally { chmodSync(dir, 0o700); }
	assert.equal(t.setTiming(true), true);
	assert.equal(t.usageStatus(), false, "the unsaved change still applies until restart");
	assert.equal(JSON.parse(readFileSync(file2, "utf8")).status, undefined, "only the saved switch reaches the file");
}));

test("completions offer status and its on/off", () => {
	assert.deepEqual(relayArgumentCompletions("st")?.map((i) => i.value), ["stats", "status"]);
	assert.deepEqual(relayArgumentCompletions("status")?.map((i) => i.value), ["status"]);
	assert.deepEqual(relayArgumentCompletions("status ")?.map((i) => i.value), ["status on", "status off"]);
	assert.equal(relayArgumentCompletions("status on "), null);
});

test("reset settings default to always and full; a missing, corrupt or unknown value means the default", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	const read = () => { const s = createSettings(file); return [s.resetWhen(), s.resetFormat()]; };
	assert.deepEqual(read(), ["always", "full"]);
	writeFileSync(file, "garbage");
	assert.deepEqual(read(), ["always", "full"]);
	for (const v of [{ resetWhen: "NEAR", resetFormat: "Compact" }, { resetWhen: "off", resetFormat: "off" }, { resetWhen: 1, resetFormat: null }, "near", {}]) { writeFileSync(file, JSON.stringify({ status: v })); assert.deepEqual(read(), ["always", "full"], JSON.stringify(v)); }
	writeFileSync(file, JSON.stringify({ status: { resetWhen: "near", resetFormat: "compact" } }));
	assert.deepEqual(read(), ["near", "compact"]);
	writeFileSync(file, JSON.stringify({ status: { resetWhen: "never" } }));
	assert.deepEqual(read(), ["never", "full"]);
}));

test("setResetWhen and setResetFormat persist under status next to status.usage and unknown keys", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	writeFileSync(file, JSON.stringify({ other: 1, status: { usage: false, future: "x" } }));
	const s = createSettings(file);
	assert.equal(s.setResetWhen("near"), true);
	assert.equal(s.setResetFormat("compact"), true);
	assert.deepEqual([s.resetWhen(), s.resetFormat()], ["near", "compact"]);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { other: 1, status: { usage: false, future: "x", resetWhen: "near", resetFormat: "compact" } });
	const t = createSettings(file);
	assert.deepEqual([t.resetWhen(), t.resetFormat(), t.usageStatus()], ["near", "compact", false]);
}));

test("/claude-relay reset shows both, sets when or format and repaints; invalid input warns with the usage and changes nothing", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	const s = createSettings(file);
	const notes: [string, string | undefined][] = [];
	let repaints = 0;
	const run = (args: string) => runRelayCommand(args, s, { notify: (m, t) => notes.push([m, t]) }, undefined, undefined, () => repaints++);
	run("reset");
	assert.deepEqual(notes.pop(), ["Claude relay reset time in status bar: always, full", "info"]);
	run("reset when Near");
	assert.deepEqual(notes.pop(), ["Claude relay reset time in status bar: near, full", "info"]);
	run("reset format compact");
	assert.deepEqual(notes.pop(), ["Claude relay reset time in status bar: near, compact", "info"]);
	assert.equal(repaints, 2);
	const saved = { status: { resetWhen: "near", resetFormat: "compact" } };
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), saved);
	for (const bad of ["reset compact", "reset when", "reset when off", "reset format never", "reset format full now", "reset maybe full"]) {
		run(bad);
		assert.deepEqual(notes.pop(), [COMMAND_USAGE, "warning"], bad);
	}
	assert.equal(repaints, 2);
	assert.deepEqual([s.resetWhen(), s.resetFormat()], ["near", "compact"]);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), saved);
	run("reset when never");
	assert.equal(s.resetWhen(), "never");
	assert.equal(repaints, 3);
}));

test("completions offer reset, its when/format and their values", () => {
	assert.deepEqual(relayArgumentCompletions("re")?.map((i) => i.value), ["reset"]);
	assert.deepEqual(relayArgumentCompletions("reset ")?.map((i) => i.value), ["reset when", "reset format"]);
	assert.deepEqual(relayArgumentCompletions("reset when ")?.map((i) => i.value), ["reset when always", "reset when near", "reset when never"]);
	assert.deepEqual(relayArgumentCompletions("reset format c")?.map((i) => i.value), ["reset format compact"]);
	assert.equal(relayArgumentCompletions("reset format full "), null);
});

test("status label is claude by default; a missing, corrupt or unknown status.label means claude; it persists next to the other status keys", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	assert.equal(createSettings(file).statusLabel(), "claude");
	for (const v of [{ label: "Relay" }, { label: "symbol" }, { label: "spark" }, { label: 1 }, "relay", {}]) { writeFileSync(file, JSON.stringify({ status: v })); assert.equal(createSettings(file).statusLabel(), "claude", JSON.stringify(v)); }
	writeFileSync(file, JSON.stringify({ status: { usage: false, resetWhen: "never" } }));
	const s = createSettings(file);
	assert.equal(s.setStatusLabel("relay"), true);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: { usage: false, resetWhen: "never", label: "relay" } });
	assert.equal(createSettings(file).statusLabel(), "relay");
	for (const v of ["loop", "asterisk", "star", "keycap"] as const) { assert.equal(s.setStatusLabel(v), true); assert.equal(createSettings(file).statusLabel(), v); }
}));

test("/claude-relay label shows, sets and repaints; invalid input warns with the usage and changes nothing", () => inTmp((dir) => {
	const file = join(dir, "s.json");
	const s = createSettings(file);
	const notes: [string, string | undefined][] = [];
	let repaints = 0;
	const run = (args: string) => runRelayCommand(args, s, { notify: (m, t) => notes.push([m, t]) }, undefined, undefined, () => repaints++);
	run("label");
	assert.deepEqual(notes.pop(), ["Claude relay status bar label: claude", "info"]);
	run("label relay");
	assert.deepEqual(notes.pop(), ["Claude relay status bar label: relay", "info"]);
	assert.equal(repaints, 1);
	run("label asterisk");
	assert.deepEqual(notes.pop(), ["Claude relay status bar label: asterisk", "info"]);
	run("label loop");
	assert.deepEqual(notes.pop(), ["Claude relay status bar label: loop", "info"]);
	run("label relay");
	notes.pop();
	assert.equal(repaints, 4);
	for (const bad of ["label icon", "label symbol", "label spark", "label claude now"]) { run(bad); assert.deepEqual(notes.pop(), [COMMAND_USAGE, "warning"], bad); }
	assert.equal(repaints, 4);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { status: { label: "relay" } });
}));

test("completions offer label and its claude/relay/loop/asterisk/star/keycap", () => {
	assert.deepEqual(relayArgumentCompletions("la")?.map((i) => i.value), ["label"]);
	assert.deepEqual(relayArgumentCompletions("label ")?.map((i) => i.value), ["label claude", "label relay", "label loop", "label asterisk", "label star", "label keycap"]);
	assert.equal(relayArgumentCompletions("label relay "), null);
});
