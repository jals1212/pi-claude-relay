import { test } from "node:test";
import assert from "node:assert/strict";
import { createStats, statsText } from "../src/stats.ts";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

test("empty stats: zeros, hit rate 0 (no division by zero), no last turn", () => {
	const s = createStats().summary();
	assert.deepEqual(s, { turns: 0, spawns: 0, resumes: 0, restarts: { total: 0, byReason: {} }, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, hitRate: 0, warmRequests: 0, throwawayTurns: 0, last: undefined });
});

test("aggregates turns, spawns, restarts by reason and token totals; hitRate = cacheRead / (input + cacheRead + cacheWrite)", () => {
	const st = createStats();
	st.record("A", { plan: "spawn", usage: usage(10, 5, 0, 90), stopReason: "stop" });
	st.record("A", { plan: "send", usage: usage(10, 5, 80, 10), stopReason: "stop" });
	st.record("B", { plan: "spawn", usage: usage(0, 0, 0, 0), stopReason: "aborted" });
	st.record("A", { plan: "restart", reason: "model", usage: usage(0, 1, 0, 0) });
	st.record("A", { plan: "resolve" }); // no usage: counted as a turn, adds nothing
	const s = st.summary();
	assert.equal(s.turns, 5);
	assert.equal(s.spawns, 2);
	assert.deepEqual(s.restarts, { total: 1, byReason: { model: 1 } });
	assert.deepEqual([s.input, s.output, s.cacheRead, s.cacheWrite], [20, 11, 80, 100]);
	assert.equal(s.hitRate, 80 / 200);
	assert.deepEqual(s.last, { sessionKey: "A", plan: "resolve" });
});

test("restart without a reason counts as `other`; the last turn is kept with its session key", () => {
	const st = createStats();
	st.record("A", { plan: "restart" });
	st.record("B", { plan: "restart", reason: "abort", stopReason: "stop", usage: usage(1, 2, 3, 4) });
	const s = st.summary();
	assert.deepEqual(s.restarts, { total: 2, byReason: { other: 1, abort: 1 } });
	assert.deepEqual(s.last, { sessionKey: "B", plan: "restart", reason: "abort", stopReason: "stop", usage: usage(1, 2, 3, 4) });
});

test("warm requests and throwaway turns are counted separately and stay out of the main totals", () => {
	const st = createStats();
	st.recordWarm(); st.recordWarm();
	st.record("tmp", { plan: "spawn", usage: usage(5, 5, 5, 5) }, { throwaway: true });
	const s = st.summary();
	assert.equal(s.warmRequests, 2);
	assert.equal(s.throwawayTurns, 1);
	assert.deepEqual([s.turns, s.spawns, s.input, s.cacheRead, s.hitRate, s.last], [0, 0, 0, 0, 0, undefined]);
});

test("summary is a snapshot: later records do not mutate a previous summary", () => {
	const st = createStats();
	st.record("A", { plan: "restart", reason: "model" });
	const before = st.summary();
	st.record("A", { plan: "restart", reason: "model" });
	assert.deepEqual(before.restarts, { total: 1, byReason: { model: 1 } });
});

test("statsText: exact text without restarts", () => {
	const st = createStats();
	st.record("A", { plan: "spawn", usage: usage(10, 5, 0, 90) });
	st.record("A", { plan: "send", usage: usage(10, 5, 80, 10) });
	st.recordWarm();
	assert.equal(statsText(st.summary()), "Claude relay stats: 2 turns · cache hit 40%\nprocess starts: 1 · restarts: 0\ncache warm requests answered locally: 1 · one-off requests: 0");
});

test("statsText: restarts list sorted by count desc then name; hit rate rounded to an integer", () => {
	const st = createStats();
	st.record("A", { plan: "spawn", usage: usage(1, 0, 2, 0) });
	for (const reason of ["model", "abort", "abort", "history", "abort", "model"]) st.record("A", { plan: "restart", reason });
	st.record("T", { plan: "spawn" }, { throwaway: true });
	assert.equal(statsText(st.summary()), "Claude relay stats: 7 turns · cache hit 67%\nprocess starts: 1 · restarts: 6 (abort 3, model 2, history 1)\ncache warm requests answered locally: 0 · one-off requests: 1");
});


test("resumed restarts are counted in `resumes` and still count as restarts", () => {
	const st = createStats();
	st.record("A", { plan: "spawn", resumed: false });
	st.record("A", { plan: "restart", reason: "credential", resumed: true });
	st.record("A", { plan: "restart", reason: "system-prompt", resumed: false });
	st.record("T", { plan: "restart", reason: "exit", resumed: true }, { throwaway: true });
	const s = st.summary();
	assert.equal(s.resumes, 1);
	assert.deepEqual(s.restarts, { total: 2, byReason: { credential: 1, "system-prompt": 1 } });
});

test("statsText: the process line gains `· resumed: N` only when N > 0", () => {
	const st = createStats();
	st.record("A", { plan: "spawn" });
	st.record("A", { plan: "restart", reason: "credential", resumed: true });
	st.record("A", { plan: "restart", reason: "credential", resumed: true });
	st.record("A", { plan: "restart", reason: "history", resumed: false });
	assert.equal(statsText(st.summary()), "Claude relay stats: 4 turns · cache hit 0%\nprocess starts: 1 · restarts: 3 (credential 2, history 1) · resumed: 2\ncache warm requests answered locally: 0 · one-off requests: 0");
});

test("statsText with latency: off names the switch; on without samples says so; on with samples appends the timing summary", () => {
	const st = createStats();
	st.record("A", { plan: "spawn", usage: usage(10, 5, 0, 90), stopReason: "stop" });
	const cache = "Claude relay stats: 1 turns · cache hit 0%\nprocess starts: 1 · restarts: 0\ncache warm requests answered locally: 0 · one-off requests: 0";
	assert.equal(statsText(st.summary(), { on: false, summary: { requests: 0 } }), `${cache}\nlatency timing: off (/claude-relay timing on records it)`);
	assert.equal(statsText(st.summary(), { on: true, summary: { requests: 0 } }), `${cache}\nlatency timing: on, no timed requests yet`);
	const summary = { requests: 2, firstEvent: { n: 2, median: 40, p90: 50 }, total: { n: 2, median: 900, p90: 1000 }, generationRate: { n: 2, median: 80, p10: 60 } };
	assert.equal(statsText(st.summary(), { on: true, summary }), [
		cache,
		"latency, last 2 requests · median / p90",
		"first event: 40 / 50 ms (n=2)",
		"total: 900 / 1000 ms (n=2)",
		"output rate: 80 tok/s median, 60 slowest 10% (n=2)",
	].join("\n"));
});
