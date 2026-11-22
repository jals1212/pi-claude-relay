import { test } from "node:test";
import assert from "node:assert/strict";
import { paint } from "../src/footer-color.ts";
import { anthropicRateLimitHeaders, describeRateLimitHeaders, createRateLimitHandler, retryableRateLimitMessage } from "../src/rate-limit.ts";

const NOW = 1_800_000_000_000;
const info = (over: any = {}) => ({
	status: "allowed", resetsAt: NOW / 1000 + 2 * 3600 + 5 * 60, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
	unifiedWindows: { five_hour: { utilization: 0.14, resetsAt: NOW / 1000 + 7500, status: "allowed" }, seven_day: { utilization: 0.5, resetsAt: NOW / 1000 + 200_000, status: "allowed" } },
	...over,
});

test("claude's rate_limit_info maps to Anthropic's anthropic-ratelimit-unified-* headers", () => {
	const h = anthropicRateLimitHeaders(info());
	assert.deepEqual(h, {
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-reset": String(NOW / 1000 + 7500),
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-overage-status": "rejected",
		"anthropic-ratelimit-unified-5h-utilization": "0.14",
		"anthropic-ratelimit-unified-5h-reset": String(NOW / 1000 + 7500),
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.5",
		"anthropic-ratelimit-unified-7d-reset": String(NOW / 1000 + 200_000),
		"anthropic-ratelimit-unified-7d-status": "allowed",
	});
});

test("headers tolerate a minimal info and ignore garbage", () => {
	assert.deepEqual(anthropicRateLimitHeaders({ status: "rejected", resetsAt: 9 }), { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "9" });
	assert.deepEqual(anthropicRateLimitHeaders(undefined), {});
	assert.deepEqual(anthropicRateLimitHeaders("x"), {});
});

test("allowed: short footer with utilization, no notification", () => {
	const d = describeRateLimitHeaders(anthropicRateLimitHeaders(info()), NOW)!;
	assert.equal(d.severity, "ok");
	assert.equal(d.footer, "Claude 5h 14% · 7d 50%");
	assert.equal(d.message, undefined);
});

test("allowed without utilization: footer is just ok", () => {
	const d = describeRateLimitHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, NOW)!;
	assert.equal(d.footer, "Claude ok");
});

test("allowed_warning: warning message with window, utilization and reset time", () => {
	const d = describeRateLimitHeaders(anthropicRateLimitHeaders(info({ status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: NOW / 1000 + 2400, status: "allowed_warning" } }, resetsAt: NOW / 1000 + 2400 })), NOW)!;
	assert.equal(d.severity, "warning");
	assert.match(d.footer, /^Claude 5h 91% · resets in 40m$/);
	assert.match(d.message!, /^Claude usage warning \(5-hour window\): 91% used\. Resets in 40m \(.+\)\.$/);
});

test("rejected: error message and footer with reset", () => {
	const d = describeRateLimitHeaders(anthropicRateLimitHeaders({ status: "rejected", resetsAt: NOW / 1000 + 7500, rateLimitType: "seven_day_opus" }), NOW)!;
	assert.equal(d.severity, "error");
	assert.equal(d.footer, "Claude limit reached · resets in 2h 5m");
	assert.match(d.message!, /^Claude usage limit reached \(7-day Opus window\)\. Resets in 2h 5m \(.+\)\./);
});

test("no unified status header: nothing to describe", () => {
	assert.equal(describeRateLimitHeaders({ "content-type": "x" }, NOW), undefined);
});

function fakeCtx() {
	const status: [string, string | undefined][] = [];
	const notes: [string, string | undefined][] = [];
	return { status, notes, ctx: { ui: { setStatus: (k: string, v?: string) => status.push([k, v]), notify: (m: string, t?: string) => notes.push([m, t]) } } as any };
}

test("handler sets the footer on every response and notifies only for non-allowed states, once per distinct state", () => {
	const handle = createRateLimitHandler({ now: () => NOW });
	const { status, notes, ctx } = fakeCtx();
	const ev = (i: any, code = 200) => ({ status: code, headers: anthropicRateLimitHeaders(i) });
	handle(ev(info()), ctx);
	assert.deepEqual(notes, []);
	assert.deepEqual(status, [["claude-relay", "Claude 5h 14% · 7d 50%"]]);
	handle(ev(info({ status: "allowed_warning" })), ctx);
	handle(ev(info({ status: "allowed_warning" })), ctx);
	assert.equal(notes.length, 1);
	assert.equal(notes[0][1], "warning");
	handle(ev(info({ status: "rejected" }), 429), ctx);
	assert.equal(notes.length, 2);
	assert.equal(notes[1][1], "error");
	assert.equal(status.length, 4);
});

test("notification switches: each pop-up can be turned off independently; footer and the other pop-up are unaffected", () => {
	const ev = (i: any, code = 200) => ({ status: code, headers: anthropicRateLimitHeaders(i) });
	const run = (n: { warning: boolean; limit: boolean }) => {
		const handle = createRateLimitHandler({ now: () => NOW, notifications: () => n });
		const { status, notes, ctx } = fakeCtx();
		handle(ev(info({ status: "allowed_warning" })), ctx);
		handle(ev(info({ status: "rejected" }), 429), ctx);
		return { status, notes };
	};
	let r = run({ warning: false, limit: true });
	assert.deepEqual(r.notes.map((n) => n[1]), ["error"]);
	assert.equal(r.status.length, 2);
	assert.match(r.status[1][1], /^Claude limit reached/);
	r = run({ warning: true, limit: false });
	assert.deepEqual(r.notes.map((n) => n[1]), ["warning"]);
	assert.equal(r.status.length, 2);
	r = run({ warning: false, limit: false });
	assert.deepEqual(r.notes, []);
	assert.equal(r.status.length, 2);
	r = run({ warning: true, limit: true });
	assert.deepEqual(r.notes.map((n) => n[1]), ["warning", "error"]);
});

test("notification switches are read on every response, and a muted state is notified once re-enabled", () => {
	const n = { warning: false, limit: true };
	const handle = createRateLimitHandler({ now: () => NOW, notifications: () => n });
	const { notes, ctx } = fakeCtx();
	const warn = { status: 200, headers: anthropicRateLimitHeaders(info({ status: "allowed_warning" })) };
	handle(warn, ctx);
	assert.deepEqual(notes, []);
	n.warning = true;
	handle(warn, ctx);
	assert.equal(notes.length, 1);
});

test("handler ignores responses without Anthropic unified headers and never throws on a missing ui", () => {
	const handle = createRateLimitHandler({ now: () => NOW });
	const { status, ctx } = fakeCtx();
	handle({ status: 200, headers: { "x-other": "1" } }, ctx);
	assert.deepEqual(status, []);
	assert.doesNotThrow(() => handle({ status: 200, headers: anthropicRateLimitHeaders(info({ status: "rejected" })) }, {} as any));
});

test("retryableRateLimitMessage: 429/rate limit text is kept as is", () => {
	assert.equal(retryableRateLimitMessage("API Error: 429 rate limited", {}), "API Error: 429 rate limited");
	assert.equal(retryableRateLimitMessage("Rate limit reached", {}), "Rate limit reached");
});

test("retryableRateLimitMessage: structured 429 or limit wording gains a '429 rate limit' prefix Pi's retry classifier matches", () => {
	assert.equal(retryableRateLimitMessage("Something odd", { api_error_status: 429 }), "429 rate limit: Something odd");
	assert.equal(retryableRateLimitMessage("You've hit your limit · resets 5pm", {}), "429 rate limit: You've hit your limit · resets 5pm");
	assert.equal(retryableRateLimitMessage("Overloaded", {}, "rejected"), "429 rate limit: Overloaded");
});

test("retryableRateLimitMessage: unrelated errors are untouched", () => {
	assert.equal(retryableRateLimitMessage("Invalid model", { api_error_status: 400 }), "Invalid model");
	assert.equal(retryableRateLimitMessage("Invalid model", {}, "allowed"), "Invalid model");
});

test("reset countdown: minutes, hours and minutes, then days and hours", () => {
	const footer = (secondsAhead: number) => describeRateLimitHeaders(anthropicRateLimitHeaders({ status: "rejected", resetsAt: NOW / 1000 + secondsAhead }), NOW)!.footer;
	assert.equal(footer(20), "Claude limit reached · resets in less than a minute");
	assert.equal(footer(45 * 60), "Claude limit reached · resets in 45m");
	assert.equal(footer(47 * 3600 + 59 * 60), "Claude limit reached · resets in 47h 59m");
	assert.equal(footer(48 * 3600), "Claude limit reached · resets in 2d");
	assert.equal(footer(4 * 86400 + 23 * 3600 + 40 * 60), "Claude limit reached · resets in 4d 23h");
	assert.equal(footer(4 * 86400 + 5 * 60), "Claude limit reached · resets in 4d");
});

// Footer colors (S7): Pi's theme, thresholds as in Pi's own footer (> 90 % error, > 70 % warning).
const fake = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
const win = (five: number, seven: number, over: any = {}) => info({ unifiedWindows: { five_hour: { utilization: five, resetsAt: NOW / 1000 + 7500, status: "allowed" }, seven_day: { utilization: seven, resetsAt: NOW / 1000 + 200_000, status: "allowed" } }, ...over });
function footerWith(i: any, theme: any, now = NOW) {
	const status: any[] = [];
	createRateLimitHandler({ now: () => now })({ headers: anthropicRateLimitHeaders(i) }, { ui: { setStatus: (...a: any[]) => status.push(a), theme } } as any);
	return status;
}

test("allowed: each window is colored by its own utilization", () => {
	assert.deepEqual(footerWith(win(0.14, 0.5), fake), [["claude-relay", "Claude <success>5h 14%</success> · <success>7d 50%</success>"]]);
	assert.deepEqual(footerWith(win(0.14, 0.75), fake), [["claude-relay", "Claude <success>5h 14%</success> · <warning>7d 75%</warning>"]]);
	assert.deepEqual(footerWith(win(0.91, 0.5), fake), [["claude-relay", "Claude <error>5h 91%</error> · <success>7d 50%</success>"]]);
});

test("rejected: the whole footer is error; warning state: windows by utilization and resets-in as warning", () => {
	assert.deepEqual(footerWith({ status: "rejected", resetsAt: NOW / 1000 + 7500 }, fake), [["claude-relay", "<error>Claude limit reached · resets in 2h 5m</error>"]]);
	const w = info({ status: "allowed_warning", unifiedWindows: { five_hour: { utilization: 0.91, resetsAt: NOW / 1000 + 2400, status: "allowed_warning" } }, resetsAt: NOW / 1000 + 2400 });
	assert.deepEqual(footerWith(w, fake), [["claude-relay", "Claude <error>5h 91%</error> · <warning>resets in 40m</warning>"]]);
});

test("no theme, a throwing theme, or a throwing theme getter: today's plain strings, nothing thrown", () => {
	assert.deepEqual(footerWith(win(0.14, 0.5), undefined), [["claude-relay", "Claude 5h 14% · 7d 50%"]]);
	assert.deepEqual(footerWith(win(0.14, 0.5), { fg() { throw new Error("boom"); } }), [["claude-relay", "Claude 5h 14% · 7d 50%"]]);
	const status: any[] = [];
	const ui = { setStatus: (...a: any[]) => status.push(a), get theme(): any { throw new Error("no theme"); } };
	createRateLimitHandler({ now: () => NOW })({ headers: anthropicRateLimitHeaders(win(0.14, 0.5)) }, { ui } as any);
	assert.deepEqual(status, [["claude-relay", "Claude 5h 14% · 7d 50%"]]);
	assert.deepEqual(footerWith({ status: "rejected", resetsAt: NOW / 1000 + 7500 }, undefined), [["claude-relay", "Claude limit reached · resets in 2h 5m"]]);
});

test("described footer stays plain text and exposes colored segments", () => {
	const d = describeRateLimitHeaders(anthropicRateLimitHeaders(win(0.14, 0.75)), NOW)!;
	assert.equal(d.footer, "Claude 5h 14% · 7d 75%");
	assert.equal(paint(d.segments, fake), "Claude <success>5h 14%</success> · <warning>7d 75%</warning>");
});
