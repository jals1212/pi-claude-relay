import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTiming, timingStat, timingStateText, latencyLines, TIMING_SAMPLE_CAP } from "../src/timing.ts";
import type { TurnReport } from "../src/provider.ts";

const report = (over: Partial<TurnReport["info"]> = {}, extra: Partial<TurnReport> = {}): TurnReport => ({
	sessionKey: "SESSION-KEY-ABC", throwaway: false, systemPromptHash: "h", toolsHash: "h", messages: 3,
	info: { plan: "send", resumed: false, usage: { input: 1, output: 42, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timing: { model: "claude-sonnet-5-5", firstLine: 50, messageStart: 60, firstText: 80, stop: 120, settle: 125.04 }, ...over },
	...extra,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

test("timingStat: median (mean of the middle pair when even) and nearest-rank p90 on known samples", () => {
	assert.equal(timingStat([]), undefined);
	assert.deepEqual(timingStat([5]), { n: 1, median: 5, p90: 5 });
	assert.deepEqual(timingStat([5, 1, 3, 2, 4]), { n: 5, median: 3, p90: 5 });
	assert.deepEqual(timingStat([100, 10, 90, 20, 80, 30, 70, 40, 60, 50]), { n: 10, median: 55, p90: 90 });
	const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
	assert.deepEqual(timingStat(hundred), { n: 100, median: 50.5, p90: 90 });
});

test("off: nothing is recorded, no write happens and the summary stays empty", async () => {
	const writes: string[] = [];
	const t = createTiming({ file: "/x/t.jsonl", enabled: () => false, append: async (_f, line) => { writes.push(line); } });
	t.record(report());
	await flush();
	assert.deepEqual(writes, []);
	assert.equal(t.summary().requests, 0);
});

test("on: one JSON line per turn with times and sizes only; the session key is hashed; async write errors are swallowed", async () => {
	const writes: [string, string][] = [];
	const t = createTiming({ file: "/x/t.jsonl", enabled: () => true, append: async (f, line) => { writes.push([f, line]); } });
	t.record(report({ plan: "restart", reason: "model" }));
	await flush();
	assert.equal(writes.length, 1);
	const [file, line] = writes[0];
	assert.equal(file, "/x/t.jsonl");
	assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1, "exactly one line");
	const rec = JSON.parse(line);
	assert.deepEqual(Object.keys(rec).sort(), ["firstLine", "firstText", "messageStart", "model", "output", "plan", "reason", "session", "settle", "stop", "stopReason", "t"]);
	assert.equal(rec.model, "claude-sonnet-5-5"); assert.equal(rec.output, 42); assert.equal(rec.stopReason, "stop");
	assert.equal(rec.plan, "restart"); assert.equal(rec.reason, "model");
	assert.equal(rec.settle, 125); assert.equal(rec.firstText, 80);
	assert.match(rec.session, /^[0-9a-f]{8}$/);
	assert.equal(line.includes("SESSION-KEY"), false);
	// a failing or throwing disk never reaches the caller
	const bad = createTiming({ file: "/x", enabled: () => true, append: () => Promise.reject(new Error("disk")) });
	assert.doesNotThrow(() => bad.record(report()));
	const throwing = createTiming({ file: "/x", enabled: () => true, append: () => { throw new Error("sync"); } });
	assert.doesNotThrow(() => throwing.record(report()));
	await flush();
});

test("a turn without marks (timing was off when it ran) is not recorded even if timing is on now", async () => {
	const writes: string[] = [];
	const t = createTiming({ file: "/x", enabled: () => true, append: async (_f, l) => { writes.push(l); } });
	t.record(report({ timing: undefined }));
	await flush();
	assert.deepEqual(writes, []);
	assert.equal(t.summary().requests, 0);
});

test("the real file gets the line (mode 0600) and holds no prompt text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-timing-"));
	try {
		const file = join(dir, "claude-relay-timing.jsonl");
		const t = createTiming({ file, enabled: () => true });
		t.record(report());
		for (let i = 0; i < 50 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).output, 42);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("summary: median and p90 per metric; first output is the earlier of text and tool call; errors and one-off requests are left out", () => {
	const t = createTiming({ file: "/x", enabled: () => true, append: async () => {} });
	const timing = (n: number) => ({ model: "m", firstLine: n, firstThinking: n % 20 === 10 ? n + 5 : undefined, firstText: n * 2, firstTool: n % 3 === 0 ? n : undefined, settle: n * 10 });
	for (const n of [10, 20, 30, 40, 50]) t.record(report({ timing: timing(n) }));
	t.record(report({ timing: timing(999), stopReason: "error" }));
	t.record(report({ timing: timing(999) }, { throwaway: true }));
	const s = t.summary();
	assert.equal(s.requests, 5);
	assert.deepEqual(s.firstEvent, { n: 5, median: 30, p90: 50 });
	assert.deepEqual(s.firstThinking, { n: 3, median: 35, p90: 55 });
	// firstVisible: n=10→20, 20→40, 30→min(60,30)=30, 40→80, 50→100
	assert.deepEqual(s.firstVisible, { n: 5, median: 40, p90: 100 });
	assert.deepEqual(s.total, { n: 5, median: 300, p90: 500 });
});

test("output rate: output tokens per second from the first generated token (thinking, text or tool call) to the stop; median and slowest 10%", () => {
	const t = createTiming({ file: "/x", enabled: () => true, append: async () => {} });
	// thinking starts first: 100 tokens over 2000 - 1000 ms = 100 tok/s
	t.record(report({ usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, timing: { model: "m", firstThinking: 1000, firstText: 1500, stop: 2000, settle: 2100 } }));
	// a tool call before any text: 50 tokens over 1000 ms = 50 tok/s
	t.record(report({ usage: { input: 1, output: 50, cacheRead: 0, cacheWrite: 0 }, timing: { model: "m", firstTool: 500, stop: 1500, settle: 1600 } }));
	// no stop mark: the settle closes the window; 200 tokens over 1000 ms = 200 tok/s
	t.record(report({ usage: { input: 1, output: 200, cacheRead: 0, cacheWrite: 0 }, timing: { model: "m", firstText: 1000, settle: 2000 } }));
	// left out of the rate: no output, no generated token, a zero window
	t.record(report({ usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, timing: { model: "m", firstText: 10, stop: 20, settle: 30 } }));
	t.record(report({ timing: { model: "m", firstLine: 5, settle: 30 } }));
	t.record(report({ timing: { model: "m", firstText: 40, stop: 40, settle: 41 } }));
	const s = t.summary();
	assert.equal(s.requests, 6);
	assert.deepEqual(s.generationRate, { n: 3, median: 100, p10: 50 });
});

test("the in-memory sample is capped at the most recent requests", () => {
	assert.equal(TIMING_SAMPLE_CAP, 500);
	const t = createTiming({ file: "/x", enabled: () => true, max: 3, append: async () => {} });
	for (const n of [1, 2, 3, 4, 5]) t.record(report({ timing: { model: "m", settle: n } }));
	const s = t.summary();
	assert.equal(s.requests, 3);
	assert.deepEqual(s.total, { n: 3, median: 4, p90: 5 });
});

test("timingStateText: the switch state and the log path only; the summary lives in /claude-relay stats", () => {
	assert.equal(timingStateText(false, "/p/t.jsonl"), "Claude relay timing: off");
	assert.equal(timingStateText(true, "/p/t.jsonl"), "Claude relay timing: on (/p/t.jsonl)");
});

test("latencyLines: the summary block, with the output rate line only when a request produced a rate; one line when off or nothing was timed", () => {
	const t = createTiming({ file: "/p/t.jsonl", enabled: () => true, append: async () => {} });
	t.record(report());
	assert.deepEqual(latencyLines(true, t.summary()), [
		"latency, last 1 request · median / p90",
		"first event: 50 / 50 ms (n=1)",
		"first text or tool call: 80 / 80 ms (n=1)",
		"total: 125 / 125 ms (n=1)",
		"output rate: 1050 tok/s median, 1050 slowest 10% (n=1)",
	]);
	const none = createTiming({ file: "/p/t.jsonl", enabled: () => true, append: async () => {} });
	none.record(report({ timing: { model: "m", settle: 10 } }));
	assert.deepEqual(latencyLines(true, none.summary()), ["latency, last 1 request · median / p90", "total: 10 / 10 ms (n=1)"]);
	assert.deepEqual(latencyLines(true, { requests: 0 }), ["latency timing: on, no timed requests yet"]);
	assert.deepEqual(latencyLines(false, t.summary()), ["latency timing: off (/claude-relay timing on records it)"]);
});
