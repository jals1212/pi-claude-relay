import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelayProvider, effortFor } from "../src/provider.ts";
import type { RelaySession, StreamRequest } from "../src/session.ts";

const costCalls: [string, any][] = [];

function fakePiAi() {
	return {
		calculateCost: (m: any, usage: any) => { costCalls.push([m.id, usage]); usage.cost.total = 42; return usage.cost; },
		collapseSystemMessages: (ctx: any) => ({ messages: ctx.messages.filter((m: any) => m.role !== "system"), collapsed: true }),
		getCurrentSystemPrompt: (_m: any[]) => "SYS",
		getCurrentTools: (_m: any[]) => [{ name: "read", description: "R", parameters: { type: "object" } }],
		createAssistantMessageEventStream: () => {
			const events: any[] = [];
			let ended = false;
			return { events, push: (e: any) => events.push(e), end: () => { ended = true; }, get ended() { return ended; } };
		},
	};
}

function setup() {
	const created: string[] = [];
	const requests: [string, StreamRequest][] = [];
	const closed: string[] = [];
	const provider = createRelayProvider({
		piAi: fakePiAi() as any,
		cwd: () => "/work",
		newSession: (key) => {
			created.push(key);
			const s: RelaySession = {
				async stream(req, emit) { requests.push([key, req]); emit({ type: "start", partial: {} as any }); emit({ type: "done", reason: "stop", message: { key } as any }); },
				async close() { closed.push(key); },
			};
			return s;
		},
	});
	return { provider, created, requests, closed };
}

const model = { id: "claude-sonnet-5-5", reasoning: true } as any;
const ctx = { messages: [{ role: "system", content: "SYS" }, { role: "user", content: "hola", timestamp: 1 }] } as any;
const flush = () => new Promise((r) => setTimeout(r, 0));

test("one relay session per Pi sessionId (S2); the same id reuses it", async () => {
	const { provider, created, requests } = setup();
	provider.keepSession("A"); provider.keepSession("B");
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	provider.streamSimple(model, ctx, { sessionId: "B" } as any);
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	await flush();
	assert.deepEqual(created, ["A", "B"]);
	assert.deepEqual(requests.map((r) => r[0]), ["A", "B", "A"]);
});

test("requests of one session run one at a time, in order", async () => {
	const order: string[] = [];
	let release!: () => void;
	const provider = createRelayProvider({
		piAi: fakePiAi() as any, cwd: () => "/w",
		newSession: () => ({
			async stream(req, emit) {
				const tag = (req.messages[0] as any).content;
				order.push(`start ${tag}`);
				if (tag === "1") await new Promise<void>((r) => { release = r; });
				order.push(`end ${tag}`);
				emit({ type: "done", reason: "stop", message: {} as any });
			},
			async close() {},
		}),
	});
	provider.streamSimple(model, { messages: [{ role: "user", content: "1", timestamp: 1 }] } as any, { sessionId: "S" } as any);
	provider.streamSimple(model, { messages: [{ role: "user", content: "2", timestamp: 1 }] } as any, { sessionId: "S" } as any);
	await flush();
	assert.deepEqual(order, ["start 1"]);
	release();
	await flush(); await flush();
	assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
});

test("stream request carries collapsed messages, system prompt, tools, cwd, model and effort; events are pushed and the stream ends", async () => {
	const { provider, requests } = setup();
	const s: any = provider.streamSimple(model, ctx, { sessionId: "A", reasoning: "minimal", apiKey: "sk-ant-oat01-space" } as any);
	await flush();
	const req = requests[0][1];
	assert.equal(req.apiKey, "sk-ant-oat01-space", "the Pi space's resolved credential travels with the request");
	assert.equal(req.model, "claude-sonnet-5-5");
	assert.equal(req.systemPrompt, "SYS");
	assert.deepEqual(req.tools.map((t) => t.name), ["read"]);
	assert.equal(req.cwd, "/work");
	assert.equal(req.effort, "low");
	assert.deepEqual(req.messages, [{ role: "user", content: "hola", timestamp: 1 }]);
	assert.deepEqual(s.events.map((e: any) => e.type), ["start", "done"]);
	assert.equal(s.ended, true);
});

test("a thrown session error becomes a terminal error event", async () => {
	const provider = createRelayProvider({ piAi: fakePiAi() as any, cwd: () => "/w", newSession: () => ({ async stream() { throw new Error("kaput"); }, async close() {} }) });
	const s: any = provider.streamSimple(model, ctx, { sessionId: "X" } as any);
	await flush();
	assert.equal(s.events.at(-1).type, "error");
	assert.equal(s.events.at(-1).error.errorMessage, "kaput");
	assert.equal(s.ended, true);
});

test("missing sessionId uses a shared fallback key", async () => {
	const { provider, created } = setup();
	provider.streamSimple(model, ctx, {} as any);
	await flush();
	assert.deepEqual(created, ["default"]);
});

test("closeAll closes every session", async () => {
	const { provider, closed } = setup();
	provider.keepSession("A"); provider.keepSession("B");
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	provider.streamSimple(model, ctx, { sessionId: "B" } as any);
	await flush();
	await provider.closeAll();
	assert.deepEqual(closed.sort(), ["A", "B"]);
});

test("effortFor maps Pi thinking levels to claude --effort", () => {
	assert.equal(effortFor(undefined, true), "off");
	assert.equal(effortFor("high", false), "off");
	assert.deepEqual(["minimal", "low", "medium", "high", "xhigh", "max"].map((l) => effortFor(l as any, true)), ["low", "low", "medium", "high", "xhigh", "max"]);
});

test("rate limit info from the session is surfaced through Pi's onResponse hook as Anthropic unified headers", async () => {
	const responses: any[] = [];
	const provider = createRelayProvider({
		piAi: fakePiAi() as any, cwd: () => "/w",
		newSession: () => ({
			async stream(req, emit) {
				req.onRateLimit?.({ status: "rejected", resetsAt: 9, rateLimitType: "five_hour" });
				req.onRateLimit?.({ status: "allowed", resetsAt: 10 });
				emit({ type: "done", reason: "stop", message: {} as any });
			},
			async close() {},
		}),
	});
	provider.streamSimple(model, ctx, { sessionId: "A", onResponse: (r: any, m: any) => { responses.push([r, m]); } } as any);
	await flush();
	assert.deepEqual(responses.map(([r]) => r), [
		{ status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "9", "anthropic-ratelimit-unified-representative-claim": "five_hour" } },
		{ status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-reset": "10" } },
	]);
	assert.equal(responses[0][1], model);
});

test("a throwing or rejecting onResponse never breaks the stream", async () => {
	for (const onResponse of [() => { throw new Error("x"); }, async () => { throw new Error("y"); }]) {
		const provider = createRelayProvider({
			piAi: fakePiAi() as any, cwd: () => "/w",
			newSession: () => ({ async stream(req, emit) { req.onRateLimit?.({ status: "allowed" }); emit({ type: "done", reason: "stop", message: {} as any }); }, async close() {} }),
		});
		const out: any = provider.streamSimple(model, ctx, { sessionId: "A", onResponse } as any);
		await flush();
		assert.equal(out.events.at(-1).type, "done");
		assert.equal(out.ended, true);
	}
});

const warmOptions = (sessionId: string) => ({ sessionId, maxTokens: 1, disableContinuation: true, maxRetries: 0, apiKey: "sk-ant-oat01-x" }) as any;

test("a cache-warm request (maxTokens 1) is answered locally: no session, no claude call, a live session is untouched, and the next real request reuses it", async () => {
	const { provider, created, requests, closed } = setup();
	provider.keepSession("A");
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	await flush();
	assert.equal(requests.length, 1);
	const warm: any = provider.streamSimple({ ...model, api: "anthropic-messages", provider: "anthropic" }, ctx, warmOptions("A"));
	const cold: any = provider.streamSimple(model, ctx, warmOptions("never-seen"));
	await flush();
	assert.equal(requests.length, 1, "no stream call reached the session");
	assert.deepEqual(created, ["A"], "no session was created, for the live id or an unknown one");
	assert.deepEqual(closed, []);
	assert.equal(provider.sessionCount(), 1);
	assert.deepEqual(warm.events.map((e: any) => e.type), ["start", "done"]);
	const done = warm.events.at(-1);
	assert.equal(done.reason, "length");
	assert.equal(done.message.stopReason, "length");
	assert.deepEqual(done.message.content, []);
	assert.equal(done.message.api, "anthropic-messages");
	assert.equal(done.message.provider, "anthropic");
	assert.equal(done.message.model, "claude-sonnet-5-5");
	assert.deepEqual(done.message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	assert.equal(warm.ended, true);
	assert.equal(cold.ended, true);
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	await flush();
	assert.deepEqual(created, ["A"], "the real request reuses the existing session");
	assert.equal(requests.length, 2);
});

test("a warm request does not wait behind a running request of the same session", async () => {
	let release!: () => void;
	const provider = createRelayProvider({
		piAi: fakePiAi() as any, cwd: () => "/w",
		newSession: () => ({ async stream(_r, emit) { await new Promise<void>((r) => { release = r; }); emit({ type: "done", reason: "stop", message: {} as any }); }, async close() {} }),
	});
	provider.keepSession("S");
	provider.streamSimple(model, ctx, { sessionId: "S" } as any);
	await flush();
	const warm: any = provider.streamSimple(model, ctx, warmOptions("S"));
	await flush();
	assert.equal(warm.ended, true);
	release();
	await flush();
});

test("a request with an unregistered session id (compaction, summaries, no id) is closed once it settles", async () => {
	const { provider, created, closed } = setup();
	provider.keepSession("main");
	const a: any = provider.streamSimple(model, ctx, { sessionId: "random-summary-id" } as any);
	const b: any = provider.streamSimple(model, ctx, {} as any);
	await flush(); await flush();
	assert.deepEqual(created, ["random-summary-id", "default"]);
	assert.deepEqual(closed.sort(), ["default", "random-summary-id"]);
	assert.equal(provider.sessionCount(), 0);
	assert.equal(a.ended, true); assert.equal(b.ended, true);
	assert.equal(a.events.at(-1).type, "done");
});

test("a failing throwaway request is still closed", async () => {
	const closed: string[] = [];
	const provider = createRelayProvider({ piAi: fakePiAi() as any, cwd: () => "/w", newSession: (k) => ({ async stream() { throw new Error("kaput"); }, async close() { closed.push(k); } }) });
	const s: any = provider.streamSimple(model, ctx, { sessionId: "tmp" } as any);
	await flush(); await flush();
	assert.equal(s.events.at(-1).error.errorMessage, "kaput");
	assert.deepEqual(closed, ["tmp"]);
	assert.equal(provider.sessionCount(), 0);
});

test("a registered session id stays alive after its request; closeSession forgets it, so a later request is throwaway", async () => {
	const { provider, closed } = setup();
	provider.keepSession("main");
	provider.streamSimple(model, ctx, { sessionId: "main" } as any);
	await flush(); await flush();
	assert.equal(provider.sessionCount(), 1);
	assert.deepEqual(closed, []);
	await provider.closeSession("main");
	assert.deepEqual(closed, ["main"]);
	provider.streamSimple(model, ctx, { sessionId: "main" } as any);
	await flush(); await flush();
	assert.equal(provider.sessionCount(), 0);
	assert.deepEqual(closed, ["main", "main"]);
});

test("a throwaway session is not closed while another request for the same id is queued behind it", async () => {
	const order: string[] = [];
	const provider = createRelayProvider({
		piAi: fakePiAi() as any, cwd: () => "/w",
		newSession: () => ({ async stream(req, emit) { order.push(`stream ${(req.messages[0] as any).content}`); emit({ type: "done", reason: "stop", message: {} as any }); }, async close() { order.push("close"); } }),
	});
	provider.streamSimple(model, { messages: [{ role: "user", content: "1", timestamp: 1 }] } as any, { sessionId: "t" } as any);
	provider.streamSimple(model, { messages: [{ role: "user", content: "2", timestamp: 1 }] } as any, { sessionId: "t" } as any);
	await flush(); await flush(); await flush();
	assert.deepEqual(order, ["stream 1", "stream 2", "close"]);
});


test("requests of a session Pi registered (keepSession) are persistent; any other key is flagged throwaway for the relay session", async () => {
	const { provider, requests } = setup();
	provider.keepSession("A");
	provider.streamSimple(model, ctx, { sessionId: "A" } as any);
	provider.streamSimple(model, ctx, { sessionId: "compaction-uuid" } as any);
	provider.streamSimple(model, ctx, {} as any);
	await flush();
	assert.deepEqual(requests.map(([key, req]) => [key, req.throwaway]), [["A", false], ["compaction-uuid", true], ["default", true]]);
});

test("the request carries a cost function that prices usage with Pi's own calculateCost and the request's model", async () => {
	const { provider, requests } = setup();
	provider.streamSimple(model, ctx, { sessionId: "A", apiKey: "sk-ant-oat01-space" } as any);
	await flush();
	const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	requests[0][1].cost!(usage);
	assert.deepEqual(usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 42 });
	assert.deepEqual(costCalls, [[model.id, usage]]);
});

test("closeAllNow closes every session synchronously and empties the pool", async () => {
	const closedNow: string[] = [];
	const provider = createRelayProvider({
		piAi: fakePiAi() as any, cwd: () => "/w",
		newSession: (key) => ({ async stream(_req, emit) { emit({ type: "done", reason: "stop", message: {} as any }); }, async close() {}, closeNow() { closedNow.push(key); } }),
	});
	provider.keepSession("A"); provider.keepSession("B");
	provider.streamSimple(model, ctx, { sessionId: "A", apiKey: "k" } as any);
	provider.streamSimple(model, ctx, { sessionId: "B", apiKey: "k" } as any);
	await flush(); await flush();
	provider.closeAllNow();
	assert.deepEqual(closedNow.sort(), ["A", "B"]);
	assert.equal(provider.sessionCount(), 0);
});
