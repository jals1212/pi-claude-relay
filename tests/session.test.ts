import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, STEER_LEAD_MS, type TurnInfo, buildClaudeArgs, buildChildEnv, mcpConfig, claudeCredential, toClaudeUserContent, type ClaudeProc, type SpawnOptions } from "../src/session.ts";
import type { RelayEvent } from "../src/turn.ts";
import type { PiMessage } from "../src/sync.ts";

class FakeProc implements ClaudeProc {
	written: any[] = [];
	killed = false;
	private lineCb: (v: any) => void = () => {};
	private exitCb: (code: number | null, stderr: string) => void = () => {};
	opts: SpawnOptions;
	constructor(opts: SpawnOptions) { this.opts = opts; }
	write(v: any) { this.written.push(v); }
	onLine(cb: (v: any) => void) { this.lineCb = cb; }
	onExit(cb: (code: number | null, stderr: string) => void) { this.exitCb = cb; }
	hardKilled = false;
	/** Set by a test to model a process that takes a moment to die (and may flush its transcript meanwhile). */
	gone?: Promise<void>;
	kill(hard?: boolean) { this.killed = true; if (hard) this.hardKilled = true; }
	emit(v: any) { this.lineCb(v); }
	exit(code: number, stderr = "") { this.exitCb(code, stderr); }
	/** Emit a full text message as raw SSE stream events. */
	text(id: string, text: string, stop = "end_turn") {
		const ev = (event: any) => this.emit({ type: "stream_event", event });
		ev({ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 0 } } });
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 2 } });
		ev({ type: "message_stop" });
	}
	toolUse(id: string, toolId: string, name: string, args: object) {
		const ev = (event: any) => this.emit({ type: "stream_event", event });
		ev({ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage: {} } });
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: `mcp__pi__${name}`, input: {} } });
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" } });
		ev({ type: "message_stop" });
	}
}

class FakeHost {
	url = "http://127.0.0.1:1/x";
	started = false; closed = false; closeCount = 0;
	expected: any[] = []; resolved: [string, any][] = []; failed: string[] = [];
	tools: any[];
	/** Set to hold `start()` until released; set `startError` to make it throw. */
	startGate?: Promise<void>; startError?: Error;
	constructor(tools: any[]) { this.tools = tools; }
	async start() { await this.startGate; if (this.startError) throw this.startError; this.started = true; }
	async close() { this.closed = true; this.closeCount++; }
	expect(c: any) { this.expected.push(c); }
	resolve(id: string, r: any) { this.resolved.push([id, r]); }
	failAll(m: string) { this.failed.push(m); this.expected = []; }
	/** Like the real host: expected calls with no delivered result yet (a dropped call is no longer pending). */
	pendingIds() { return this.expected.map((c) => c.id).filter((id) => !this.resolved.some(([r]) => r === id) && !this.dropped.includes(id)); }
	dropped: string[] = [];
	private dropCb: (id: string) => void = () => {};
	onDrop(cb: (id: string) => void) { this.dropCb = cb; }
	/** Model claude giving up on a parked call (MCP idle timeout, cancellation). */
	drop(id: string) { this.dropped.push(id); this.dropCb(id); }
}

const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }];
const OAUTH = "sk-ant-oat01-space-a";
const base = { model: "claude-sonnet-5-5", systemPrompt: "SYS", tools, effort: "medium", cwd: "/w", apiKey: OAUTH };
const u = (text: string): PiMessage => ({ role: "user", content: text, timestamp: 1 });
/** What Pi keeps in its context after the user aborts a streaming turn (agent-loop stores the final `aborted` message). */
const abortedMessage = (): PiMessage => ({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted", timestamp: 2 });
const interrupts = (p: FakeProc) => p.written.filter((w) => w?.type === "control_request");
const userLineOf = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const UUID_X = "11111111-1111-4111-8111-111111111111";
const UUID_Y = "22222222-2222-4222-8222-222222222222";
const initLine = (id: string) => ({ type: "system", subtype: "init", session_id: id });
const MESSAGE_START = { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: {} } } };

/** Manual timer: `fire()` runs every live callback once. */
class ManualTimers {
	pending: { cb: () => void; ms: number; cancelled: boolean }[] = [];
	set = (cb: () => void, ms: number) => { const t = { cb, ms, cancelled: false }; this.pending.push(t); return () => { t.cancelled = true; }; };
	live() { return this.pending.filter((t) => !t.cancelled); }
	fire() { for (const t of this.live()) { t.cancelled = true; t.cb(); } }
}

function setup(hooks: { spawnError?: Error; prepareHost?: (h: FakeHost) => void; onTurn?: (info: TurnInfo) => void; timers?: ManualTimers; removeTranscripts?: (ids: string[]) => void; timing?: () => boolean; clock?: () => number } = {}) {
	const procs: FakeProc[] = [];
	const hosts: FakeHost[] = [];
	const session = createSession({
		spawn: (o) => { if (hooks.spawnError) throw hooks.spawnError; const p = new FakeProc(o); procs.push(p); return p; },
		createHost: (t) => { const h = new FakeHost(t); hooks.prepareHost?.(h); hosts.push(h); return h as any; },
		api: "anthropic-messages", provider: "anthropic", now: () => 5, onTurn: hooks.onTurn,
		setTimer: hooks.timers?.set, removeTranscripts: hooks.removeTranscripts, timing: hooks.timing, clock: hooks.clock,
	});
	return { session, procs, hosts };
}

/** Run one stream() call; `drive` acts as claude once the request was written. */
async function turn(session: ReturnType<typeof createSession>, messages: PiMessage[], drive: () => void, extra: Partial<typeof base> & { signal?: AbortSignal } = {}) {
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, ...extra, messages }, (e) => events.push(structuredClone(e)));
	await new Promise((r) => setImmediate(r));
	drive();
	await p;
	return events;
}

test("first turn spawns claude with the MCP url and sends the user message; text comes back", async () => {
	const { session, procs, hosts } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].text("m1", "buenas"));
	assert.equal(procs.length, 1);
	assert.equal(hosts[0].started, true);
	assert.deepEqual(hosts[0].tools, tools);
	assert.equal(procs[0].opts.mcpUrl, hosts[0].url);
	assert.equal(procs[0].opts.model, "claude-sonnet-5-5");
	assert.equal(procs[0].opts.systemPrompt, "SYS");
	assert.deepEqual(procs[0].written, [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hola" }] } }]);
	assert.deepEqual(events.map((e) => e.type), ["start", "text_start", "text_delta", "text_end", "done"]);
	const done = events.at(-1) as any;
	assert.equal(done.message.responseId, "m1");
	assert.equal(done.message.content[0].text, "buenas");
});

test("second turn reuses the same process (no respawn, no replay)", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const assistant = (e1.at(-1) as any).message;
	await turn(session, [u("hola"), assistant, u("y?")], () => procs[0].text("m2", "b"));
	assert.equal(procs.length, 1);
	assert.deepEqual(procs[0].written.at(-1), { type: "user", message: { role: "user", content: [{ type: "text", text: "y?" }] } });
});

test("two user messages after a finished turn (a notice and its wake-up) reuse the same process as one user line", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const assistant = (e1.at(-1) as any).message;
	await turn(session, [u("hola"), assistant, u("resultado"), u("despierta")], () => procs[0].text("m2", "b"));
	assert.equal(procs.length, 1, "no respawn, no flattened replay");
	assert.equal(procs[0].written.length, 2);
	assert.deepEqual(procs[0].written.at(-1), { type: "user", message: { role: "user", content: [{ type: "text", text: "resultado" }, { type: "text", text: "despierta" }] } });
});

test("tool use: expects the call on the host, ends with toolUse; results are resolved on the next turn", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	assert.equal((e1.at(-1) as any).reason, "toolUse");
	assert.deepEqual(hosts[0].expected, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }]);
	const assistant = (e1.at(-1) as any).message;
	const result: PiMessage = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3 };
	const e2 = await turn(session, [u("lee"), assistant, result], () => procs[0].text("m2", "listo"));
	assert.deepEqual(hosts[0].resolved, [["toolu_1", { content: [{ type: "text", text: "data" }], isError: false }]]);
	assert.equal(procs[0].written.length, 1, "nothing written to stdin for tool results");
	assert.equal((e2.at(-1) as any).message.content[0].text, "listo");
});

test("a system prompt change respawns with a transcript replay and closes the old host and process", async () => {
	// Adapted (S9): a model change now resumes claude's session; the system prompt cannot change on resume, so it keeps the flattened replay.
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	const assistant = (e1.at(-1) as any).message;
	await turn(session, [u("hola"), assistant, u("sigue")], () => procs[1].text("m2", "b"), { systemPrompt: "SYS2" });
	assert.equal(procs[0].killed, true);
	assert.equal(hosts[0].closed, true);
	assert.equal(procs[1].opts.systemPrompt, "SYS2");
	const first = procs[1].written[0].message.content;
	assert.match(first[0].text, /^<conversation_history>\n<user>\nhola\n<\/user>\n<assistant>\na\n<\/assistant>\n<\/conversation_history>/);
	assert.deepEqual(first[1], { type: "text", text: "sigue" });
});

test("result error before any message fails the turn with claude's message", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].emit({ type: "result", subtype: "success", is_error: true, result: "API Error: 429 rate limited" }));
	assert.deepEqual(events.map((e) => e.type), ["error"]);
	assert.equal((events[0] as any).error.errorMessage, "API Error: 429 rate limited");
});

test("result error with a structured 429 or limit wording gets a message Pi's retry classifier recognises", async () => {
	for (const [result, extra, expected] of [
		["Something odd", { api_error_status: 429 }, "429 rate limit: Something odd"],
		["You've hit your 5-hour limit · resets 5pm", { api_error_status: 429 }, "429 quota exceeded: You've hit your 5-hour limit · resets 5pm"],
		["Invalid model", { api_error_status: 400 }, "Invalid model"],
	] as const) {
		const { session, procs } = setup();
		const events = await turn(session, [u("hola")], () => procs[0].emit({ type: "result", subtype: "success", is_error: true, result, ...extra }));
		assert.equal((events[0] as any).error.errorMessage, expected);
	}
});

test("a rejected rate_limit_event before an error result marks the error as an exhausted quota Pi does not retry", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => {
		procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 9 } });
		procs[0].emit({ type: "result", subtype: "success", is_error: true, result: "Overloaded" });
	});
	assert.equal((events[0] as any).error.errorMessage, "429 quota exceeded: Overloaded");
});

test("a rejected rate_limit_event from an earlier turn does not make a later error a non-retryable quota error", async () => {
	const { session, procs } = setup();
	const first = await turn(session, [u("hola")], () => {
		procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 9 } });
		procs[0].emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your 5-hour limit" });
	});
	assert.equal((first[0] as any).error.errorMessage, "429 quota exceeded: You've hit your 5-hour limit");
	const second = await turn(session, [u("otra vez")], () => procs.at(-1)!.emit({ type: "result", subtype: "success", is_error: true, result: "Internal server error" }));
	assert.equal((second.at(-1) as any).error.errorMessage, "Internal server error");
});

test("process exit mid-turn fails the turn and the next turn respawns", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(1, "boom\n"));
	assert.equal((events.at(-1) as any).type, "error");
	assert.match((events.at(-1) as any).error.errorMessage, /claude exited with code 1: boom/);
	await turn(session, [u("hola")], () => procs[1].text("m1", "ok"));
	assert.equal(procs.length, 2);
});

test("abort fails the turn as aborted, fails parked calls and interrupts claude instead of killing it", async () => {
	// Adapted (S9): the process is no longer killed on abort; it gets an interrupt control request.
	const { session, procs, hosts } = setup();
	const ac = new AbortController();
	const events = await turn(session, [u("hola")], () => {
		procs[0].emit({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: {} } } });
		ac.abort();
	}, { signal: ac.signal });
	assert.equal((events.at(-1) as any).reason, "aborted");
	assert.equal(procs[0].killed, false);
	assert.equal(interrupts(procs[0]).length, 1);
	assert.deepEqual(hosts[0].failed, ["Request was aborted"]);
});

test("already-aborted signal never spawns", async () => {
	const { session, procs } = setup();
	const ac = new AbortController(); ac.abort();
	const events: RelayEvent[] = [];
	await session.stream({ ...base, messages: [u("x")], signal: ac.signal }, (e) => events.push(e));
	assert.equal(procs.length, 0);
	assert.equal((events[0] as any).reason, "aborted");
});

test("rate_limit_event is forwarded to the listener", async () => {
	const seen: any[] = [];
	const procs: FakeProc[] = [];
	const session = createSession({ spawn: (o) => { const p = new FakeProc(o); procs.push(p); return p; }, createHost: (t) => new FakeHost(t) as any, api: "a", provider: "p", onRateLimit: (i) => seen.push(i) });
	await turn(session, [u("x")], () => { procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 9 } }); procs[0].text("m", "y"); });
	assert.deepEqual(seen, [{ status: "allowed", resetsAt: 9 }]);
});

test("rate_limit_event reaches the active request's onRateLimit; one arriving after message_stop (claude's usual order) goes to the most recent request", async () => {
	const { session, procs } = setup();
	const first: any[] = [], second: any[] = [];
	const e0 = await turn(session, [u("x")], () => { procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1 } }); procs[0].text("m1", "y"); }, { onRateLimit: (i: any) => first.push(i) });
	assert.deepEqual(first, [{ status: "allowed", resetsAt: 1 }]);
	const assistant = (e0.at(-1) as any).message;
	procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 2 } });
	assert.deepEqual(first, [{ status: "allowed", resetsAt: 1 }, { status: "allowed_warning", resetsAt: 2 }]);
	const e1 = await turn(session, [u("x"), assistant, u("z")], () => procs[0].text("m2", "y"), { onRateLimit: (i: any) => second.push(i) });
	assert.equal(procs.length, 1);
	assert.equal(e1.at(-1)!.type, "done");
	procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 3 } });
	assert.deepEqual(second, [{ status: "rejected", resetsAt: 3 }]);
});

test("the final message records the model that actually answered (responseModel), keeping Pi's model id", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => {
		const ev = (event: any) => procs[0].emit({ type: "stream_event", event });
		ev({ type: "message_start", message: { id: "m1", model: "claude-sonnet-5-5-20260101", usage: {} } });
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
		ev({ type: "message_stop" });
	}, { model: "claude-sonnet-5-5" });
	const done = events.at(-1) as any;
	assert.equal(done.message.responseModel, "claude-sonnet-5-5-20260101");
	assert.equal(done.message.model, "claude-sonnet-5-5");
});

test("close kills the process and closes the host", async () => {
	const { session, procs, hosts } = setup();
	await turn(session, [u("x")], () => procs[0].text("m", "y"));
	await session.close();
	assert.equal(procs[0].killed, true);
	assert.equal(hosts[0].closed, true);
});

test("buildClaudeArgs allows tools under the name claude gives them (characters outside letters, digits, _ and - become _)", () => {
	const args = buildClaudeArgs({ model: "m", effort: "off", toolNames: ["read", "weird.name-x", "sp ace", "ñandú"], systemPromptFile: "s", mcpConfigFile: "c" });
	assert.equal(args[args.indexOf("--allowedTools") + 1], "mcp__pi__read,mcp__pi__weird_name-x,mcp__pi__sp_ace,mcp__pi___and_");
	// ordinary names are untouched
	const plain = buildClaudeArgs({ model: "m", effort: "off", toolNames: ["a.b", "ok-1", "under_score"], systemPromptFile: "s", mcpConfigFile: "c" });
	assert.equal(plain[plain.indexOf("--allowedTools") + 1], "mcp__pi__a_b,mcp__pi__ok-1,mcp__pi__under_score");
});

test("buildClaudeArgs isolates claude: no built-in tools, strict MCP, no settings, Pi system prompt from a file", () => {
	const args = buildClaudeArgs({ model: "claude-opus-5-5", effort: "high", toolNames: ["read", "bash"], systemPromptFile: "/p/system-prompt.txt", mcpConfigFile: "/p/mcp.json" });
	assert.deepEqual(args, [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages", "--verbose",
		"--tools", "", "--strict-mcp-config", "--mcp-config", "/p/mcp.json",
		"--setting-sources", "", "--permission-mode", "default", "--allowedTools", "mcp__pi__read,mcp__pi__bash",
		"--no-session-persistence", "--model", "claude-opus-5-5", "--system-prompt-file", "/p/system-prompt.txt", "--thinking-display", "summarized", "--effort", "high",
	]);
	const off = buildClaudeArgs({ model: "m", effort: "off", toolNames: [], systemPromptFile: "s", mcpConfigFile: "c" });
	assert.ok(!off.includes("--effort"));
	assert.equal(off[off.indexOf("--thinking-display") + 1], "summarized");
});

test("buildChildEnv gives claude only the Pi space's credential and the space's config dir", () => {
	const parent = { PATH: "/bin", HOME: "/h", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "at", CLAUDE_CODE_OAUTH_TOKEN: "shared-tok", CLAUDE_CONFIG_DIR: "/h/.claude" };
	const env = buildChildEnv(parent, { kind: "oauth", value: "sk-ant-oat01-space" }, "/space/agent/claude-relay");
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-space", "the Pi space's own login reaches claude");
	assert.equal(env.CLAUDE_CONFIG_DIR, "/space/agent/claude-relay", "claude state lives in the space, never the shared ~/.claude");
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
	assert.equal(env.PATH, "/bin");
	assert.equal(env.HOME, "/h");
	assert.equal(env.CLAUDECODE, undefined);
	assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
	assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
	assert.equal(env.DISABLE_AUTO_COMPACT, "1");
	assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
	assert.equal(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, "16384");
	assert.equal(env.MCP_TOOL_TIMEOUT, "86400000");
	const keyEnv = buildChildEnv(parent, { kind: "apiKey", value: "sk-ant-api03-space" }, "/c");
	assert.equal(keyEnv.ANTHROPIC_API_KEY, "sk-ant-api03-space", "a space signed in with an API key uses that key");
	assert.equal(keyEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the shared OAuth token never leaks into another space");
});

test("claudeCredential classifies the Pi credential and refuses a space without Anthropic login", () => {
	assert.deepEqual(claudeCredential("sk-ant-oat01-abc"), { kind: "oauth", value: "sk-ant-oat01-abc" });
	assert.deepEqual(claudeCredential("sk-ant-api03-abc"), { kind: "apiKey", value: "sk-ant-api03-abc" });
	for (const missing of [undefined, "", "  "]) {
		assert.throws(() => claudeCredential(missing), { message: "pi-claude-relay: this Pi space has no Anthropic login. Run /login and choose Anthropic in this space." });
	}
});

test("the claude process gets the request's credential", async () => {
	const { session, procs } = setup();
	await turn(session, [u("hi")], () => procs[0].text("m1", "ok"));
	assert.deepEqual(procs[0].opts.credential, { kind: "oauth", value: OAUTH });
});

test("a changed credential (token refresh, other login) restarts claude by resuming its session", async () => {
	// Adapted (S9): the restart resumes the session instead of replaying a flattened transcript.
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hi")], () => procs[0].text("m1", "ok"));
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const assistant = (e1.at(-1) as any).message;
	await turn(session, [u("hi"), assistant, u("again")], () => procs[1].text("m2", "ok2"), { apiKey: "sk-ant-oat01-refreshed" });
	assert.equal(procs.length, 2);
	assert.deepEqual(procs[1].written, [{ type: "user", message: { role: "user", content: [{ type: "text", text: "again" }] } }]);
	assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
	assert.equal(procs[0].killed, true);
	assert.deepEqual(procs[1].opts.credential, { kind: "oauth", value: "sk-ant-oat01-refreshed" });
});

test("a request without Anthropic login fails with the login hint and starts no claude", async () => {
	const { session, procs } = setup();
	const events: RelayEvent[] = [];
	await session.stream({ ...base, apiKey: undefined, messages: [u("hi")] }, (e) => events.push(e));
	assert.equal(procs.length, 0);
	const last = events.at(-1) as any;
	assert.equal(last.type, "error");
	assert.equal(last.error.errorMessage, "pi-claude-relay: this Pi space has no Anthropic login. Run /login and choose Anthropic in this space.");
});

test("toClaudeUserContent converts text and base64 images", () => {
	assert.deepEqual(toClaudeUserContent("hi"), [{ type: "text", text: "hi" }]);
	assert.deepEqual(toClaudeUserContent([{ type: "text", text: "a" }, { type: "image", data: "QQ==", mimeType: "image/png" }]), [
		{ type: "text", text: "a" },
		{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
	]);
});

test("buildChildEnv drops every inherited ANTHROPIC_* variable that could reroute the space's credential", () => {
	const parent = { PATH: "/bin", ANTHROPIC_BASE_URL: "https://elsewhere", ANTHROPIC_CUSTOM_HEADERS: "x: y", ANTHROPIC_FOUNDRY_API_KEY: "k", ANTHROPIC_MODEL: "m", ANTHROPIC_UNIX_SOCKET: "/s", HTTPS_PROXY: "http://proxy:8080" };
	const env = buildChildEnv(parent, { kind: "oauth", value: "sk-ant-oat01-s" }, "/c");
	assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_")), []);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-s");
	assert.equal(env.HTTPS_PROXY, "http://proxy:8080", "network proxy settings still apply");
	const keyEnv = buildChildEnv(parent, { kind: "apiKey", value: "sk-ant-api03-s" }, "/c");
	assert.deepEqual(Object.keys(keyEnv).filter((k) => k.startsWith("ANTHROPIC_")), ["ANTHROPIC_API_KEY"]);
});

test("a claude crash never surfaces the space's credential in the error message", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(1, `auth failed for ${OAUTH}\n`));
	const msg = (events.at(-1) as any).error.errorMessage as string;
	assert.ok(!msg.includes(OAUTH), msg);
	assert.match(msg, /^claude exited with code 1: auth failed for \[redacted\]$/);
});

test("a claude error result never surfaces the space's credential", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, result: `401 bad credential ${OAUTH}` }));
	const msg = (events.at(-1) as any).error.errorMessage as string;
	assert.ok(!msg.includes(OAUTH), msg);
	assert.match(msg, /401 bad credential \[redacted\]/);
});

test("redaction follows the credential after a respawn", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hi")], () => procs[0].text("m1", "ok"));
	const assistant = (e1.at(-1) as any).message;
	const fresh = "sk-ant-oat01-refreshed";
	// Adapted (S9): the credential change resumes the session; a resumed process that dies before showing any sign of life falls back to a
	// flattened replay, so the process here starts (init line) before it dies and the failure is an ordinary one.
	const events = await turn(session, [u("hi"), assistant, u("again")], () => { procs[1].emit(initLine(UUID_X)); procs[1].exit(1, `token ${fresh} rejected\n`); }, { apiKey: fresh });
	const msg = (events.at(-1) as any).error.errorMessage as string;
	assert.ok(!msg.includes(fresh), msg);
});

// --- lifecycle (T11 / S8) ---
const tick = () => new Promise((r) => setImmediate(r));
const toolResult = (id: string): PiMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3 });

test("a tool-result request whose parked call is gone restarts with a transcript replay instead of hanging", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	hosts[0].failAll("claude's MCP client dropped"); // the host no longer knows the parked call
	const e2 = await turn(session, [u("lee"), assistant, toolResult("toolu_1")], () => procs[1].text("m2", "listo"));
	assert.equal(procs.length, 2, "a fresh claude process was started");
	assert.equal(procs[0].killed, true);
	assert.equal(hosts[0].closed, true);
	assert.equal(hosts[1].resolved.length, 0);
	assert.match(procs[1].written[0].message.content[0].text, /<tool_result id="toolu_1" name="read">\ndata\n<\/tool_result>/);
	assert.equal((e2.at(-1) as any).message.content[0].text, "listo");
});

test("a result line while the turn is unfinished fails the request instead of waiting forever", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].emit({ type: "result", subtype: "success", is_error: false, result: "" }));
	assert.equal((events.at(-1) as any).type, "error");
	assert.equal((events.at(-1) as any).error.errorMessage, "claude ended the turn without a response");
});

test("a result line that belongs to an earlier message does not fail the next request", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	const assistant = (e1.at(-1) as any).message;
	// claude's `result` for the first message arrives after the second request was already written
	const e2 = await turn(session, [u("hola"), assistant, u("y?")], () => { procs[0].emit({ type: "result", subtype: "success", is_error: false }); procs[0].text("m2", "b"); });
	assert.equal(e2.at(-1)!.type, "done");
	assert.equal(procs.length, 1);
});

test("a throwing spawn closes the host it just created and fails the turn", async () => {
	const { session, hosts } = setup({ spawnError: new Error("boom") });
	const events: RelayEvent[] = [];
	await session.stream({ ...base, messages: [u("x")] }, (e) => events.push(e));
	assert.equal(hosts[0].closed, true);
	assert.equal((events.at(-1) as any).error.errorMessage, "Claude relay failed to start: boom");
});

test("a failing host start closes the host", async () => {
	const { session, hosts } = setup({ prepareHost: (h) => { h.startError = new Error("EADDRINUSE"); } });
	const events: RelayEvent[] = [];
	await session.stream({ ...base, messages: [u("x")] }, (e) => events.push(e));
	assert.equal(hosts[0].closed, true);
	assert.match((events.at(-1) as any).error.errorMessage, /EADDRINUSE/);
});

test("an abort during host.start never spawns or writes to claude, and the host is closed", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const { session, procs, hosts } = setup({ prepareHost: (h) => { h.startGate = gate; } });
	const ac = new AbortController();
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, messages: [u("x")], signal: ac.signal }, (e) => events.push(e));
	await tick();
	ac.abort();
	await tick();
	release();
	await p;
	assert.equal(procs.length, 0, "claude was never spawned");
	assert.equal(hosts[0].closed, true);
	assert.deepEqual(events.map((e) => e.type), ["error"]);
	assert.equal((events[0] as any).reason, "aborted");
});

test("close() while a request is active ends it with an aborted error and settles the stream", async () => {
	const { session, procs, hosts } = setup();
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, messages: [u("x")] }, (e) => events.push(structuredClone(e)));
	await tick();
	procs[0].emit({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: {} } } });
	await session.close();
	await p; // would hang if close() left the turn open
	const last = events.at(-1) as any;
	assert.equal(last.type, "error");
	assert.equal(last.reason, "aborted");
	assert.equal(last.error.errorMessage, "Claude relay session closed");
	assert.equal(procs[0].killed, true);
	assert.equal(hosts[0].closed, true);
});

test("close() during host.start stops the pending request without spawning", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const { session, procs, hosts } = setup({ prepareHost: (h) => { h.startGate = gate; } });
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, messages: [u("x")] }, (e) => events.push(e));
	await tick();
	await session.close();
	release();
	await p;
	assert.equal(procs.length, 0);
	assert.equal(hosts[0].closed, true);
	assert.equal((events.at(-1) as any).reason, "aborted");
});

test("preflight: a missing claude binary gives the exact actionable message", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(null as any, "\nspawn claude ENOENT"));
	assert.equal((events.at(-1) as any).error.errorMessage, 'pi-claude-relay: the "claude" CLI was not found. Install Claude Code or set PI_CLAUDE_RELAY=off to use Pi\'s direct Anthropic provider.');
});

test("preflight: an unknown option from an old claude gets the minimum-version hint appended", async () => {
	for (const stderr of ["error: unknown option '--system-prompt-file'\n", "claude: Unrecognized option --effort\n"]) {
		const { session, procs } = setup();
		const events = await turn(session, [u("hola")], () => procs[0].exit(1, stderr));
		assert.equal((events.at(-1) as any).error.errorMessage, `claude exited with code 1: ${stderr.trim()} pi-claude-relay needs Claude Code 2.1.330 or later.`);
	}
});

test("an ordinary claude failure keeps the plain exit message (no version hint, no ENOENT text)", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(2, "ENOENT: no such file '/x'\n"));
	assert.equal((events.at(-1) as any).error.errorMessage, "claude exited with code 2: ENOENT: no such file '/x'");
});

test("an offered tool called without the prefix does not fail the turn: the next claude message completes it", async () => {
	const { session, procs, hosts } = setup();
	const events = await turn(session, [u("hola")], () => {
		const ev = (event: any) => procs[0].emit({ type: "stream_event", event });
		ev({ type: "message_start", message: { id: "m1", model: "claude-sonnet-5-5", usage: {} } });
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_bare", name: "read", input: {} } });
		ev({ type: "content_block_stop", index: 0 });
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" } });
		ev({ type: "message_stop" });
		// claude answers the unknown name itself and the model tries again
		procs[0].emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bare", is_error: true, content: "<tool_use_error>Error: No such tool available: read</tool_use_error>" }] } });
		procs[0].toolUse("m2", "toolu_1", "read", { path: "a" });
	});
	const last = events.at(-1) as any;
	assert.equal(last.type, "done");
	assert.equal(last.reason, "toolUse");
	assert.deepEqual(last.message.content, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }]);
	assert.deepEqual(hosts[0].expected, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }]);
});

test("a tool_use for a tool Pi did not offer never reaches Pi: claude answers it and its next message completes the turn", async () => {
	const { session, procs, hosts } = setup();
	const events = await turn(session, [u("hola")], () => {
		procs[0].toolUse("m1", "toolu_9", "write", { path: "x" });
		procs[0].emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: true, content: "<tool_use_error>Error: No such tool available: mcp__pi__write</tool_use_error>" }] } });
		procs[0].toolUse("m2", "toolu_1", "read", { path: "a" });
	});
	const last = events.at(-1) as any;
	assert.equal(last.type, "done");
	assert.equal(last.reason, "toolUse");
	assert.deepEqual(last.message.content, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }]);
	assert.deepEqual(hosts[0].expected, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }]);
	assert.ok(!events.some((e: any) => e.type === "toolcall_end" && e.toolCall.id === "toolu_9"));
});

test("a claude crash never surfaces the session's MCP URL", async () => {
	const { session, procs, hosts } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(1, `MCP server pi failed: ${hosts[0].url}\n`));
	const msg = (events.at(-1) as any).error.errorMessage as string;
	assert.ok(hosts[0].url.length > 0 && !msg.includes(hosts[0].url), msg);
	assert.match(msg, /MCP server pi failed: \[redacted\]/);
});


// --- prompt-cache instrumentation (T14 / S9) ---
function cachedText(p: FakeProc, id: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, stop = "end_turn") {
	const ev = (event: any) => p.emit({ type: "stream_event", event });
	ev({ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage } });
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	ev({ type: "content_block_stop", index: 0 });
	ev({ type: "message_delta", delta: { stop_reason: stop }, usage: {} });
	ev({ type: "message_stop" });
}
const USAGE_A = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 };
const USAGE_B = { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const usageOf = (u: typeof USAGE_A) => ({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });

test("onTurn: spawn for the first process, then send, with usage and stop reason of the final message", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("hola")], () => cachedText(procs[0], "m1", USAGE_A));
	assert.deepEqual(infos, [{ plan: "spawn", resumed: false, usage: usageOf(USAGE_A), stopReason: "stop" }]);
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await turn(session, [u("hola"), (e1.at(-1) as any).message, u("y?")], () => cachedText(procs[0], "m2", USAGE_B));
	assert.deepEqual(infos[1], { plan: "send", resumed: false, usage: usageOf(USAGE_B), stopReason: "stop" });
	assert.equal(infos.length, 2);
});

test("onTurn: tool results report resolve; toolUse is the stop reason of the tool turn", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	assert.equal(infos[0].plan, "spawn");
	assert.equal(infos[0].stopReason, "toolUse");
	const assistant = (e1.at(-1) as any).message;
	const result: PiMessage = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3 };
	await turn(session, [u("lee"), assistant, result], () => cachedText(procs[0], "m2", USAGE_B));
	assert.deepEqual(infos[1], { plan: "resolve", resumed: false, usage: usageOf(USAGE_B), stopReason: "stop" });
});

test("onTurn: a system prompt and tool set changed together are both listed in `changed`; the reason stays the first", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	await turn(session, [u("hola"), (e1.at(-1) as any).message, u("sigue")], () => cachedText(procs[1], "m2", USAGE_B), { systemPrompt: "OTHER", tools: [{ name: "bash", description: "Run", parameters: { type: "object" } }] } as any);
	assert.equal(infos[1].reason, "system-prompt");
	assert.deepEqual(infos[1].changed, ["system-prompt", "tools"]);
});

test("onTurn: a changed model restarts with reason `model`; the other planner reasons map to stable categories", async () => {
	const cases: [string, Partial<typeof base>, string][] = [
		["model", { model: "claude-opus-5-5" }, "model"],
		["system prompt", { systemPrompt: "OTHER" }, "system-prompt"],
		["tools", { tools: [{ name: "bash", description: "Run", parameters: { type: "object" } }] }, "tools"],
		["effort", { effort: "high" }, "effort"],
		["credential", { apiKey: "sk-ant-oat01-space-b" }, "credential"],
	];
	for (const [label, change, reason] of cases) {
		const infos: TurnInfo[] = [];
		const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
		const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
		await turn(session, [u("hola"), (e1.at(-1) as any).message, u("sigue")], () => cachedText(procs[1], "m2", USAGE_B), change as any);
		// Adapted (S9): every cause except the system prompt resumes claude's session (`resumed: true`).
		assert.deepEqual(infos[1], { plan: "restart", reason, changed: [reason], resumed: reason !== "system-prompt", usage: usageOf(USAGE_B), stopReason: "stop" }, label);
	}
});

test("onTurn: diverged history restarts with reason `history`", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	await turn(session, [u("resumen"), u("sigue")], () => procs[1].text("m2", "b"));
	assert.equal(infos[1].plan, "restart");
	assert.equal(infos[1].reason, "history");
	assert.equal(infos[1].changed, undefined, "only config restarts list changed fields");
});

test("onTurn: an abort no longer restarts: the NEXT turn is a plain send on the same process; the abort reason appears only after the interrupt timed out", async () => {
	// Adapted (S9): was "an abort makes the NEXT turn a restart with reason `abort`".
	const infos: TurnInfo[] = [];
	const timers = new ManualTimers();
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)), timers });
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: {} } } }); ac.abort(); }, { signal: ac.signal });
	assert.equal(infos.length, 1);
	assert.deepEqual(infos[0], { plan: "spawn", resumed: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "aborted" });
	const next = session.stream({ ...base, messages: [u("hola"), abortedMessage(), u("otra")] }, () => {});
	await tick();
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	await tick();
	cachedText(procs[0], "m2", USAGE_B);
	await next;
	assert.equal(procs.length, 1);
	assert.deepEqual(infos[1], { plan: "send", resumed: false, usage: usageOf(USAGE_B), stopReason: "stop" });
});

test("onTurn: an unexpected process exit and an error teardown make the next turn a restart (`exit` / `error`)", async () => {
	const exitInfos: TurnInfo[] = [];
	const a = setup({ onTurn: (i) => exitInfos.push(structuredClone(i)) });
	await turn(a.session, [u("hola")], () => a.procs[0].exit(1, "boom"));
	assert.equal(exitInfos[0].plan, "spawn");
	assert.equal(exitInfos[0].stopReason, "error");
	await turn(a.session, [u("hola")], () => a.procs[1].text("m1", "ok"));
	assert.deepEqual([exitInfos[1].plan, exitInfos[1].reason], ["restart", "exit"]);

	const errInfos: TurnInfo[] = [];
	const b = setup({ onTurn: (i) => errInfos.push(structuredClone(i)) });
	await turn(b.session, [u("hola")], () => b.procs[0].emit({ type: "result", subtype: "success", is_error: true, result: "API Error" }));
	assert.equal(errInfos[0].stopReason, "error");
	await turn(b.session, [u("hola")], () => b.procs[1].text("m1", "ok"));
	assert.deepEqual([errInfos[1].plan, errInfos[1].reason], ["restart", "error"]);

	// exit between turns (idle process dies)
	const idleInfos: TurnInfo[] = [];
	const c = setup({ onTurn: (i) => idleInfos.push(structuredClone(i)) });
	const e1 = await turn(c.session, [u("hola")], () => c.procs[0].text("m1", "a"));
	c.procs[0].exit(137, "");
	await turn(c.session, [u("hola"), (e1.at(-1) as any).message, u("sigue")], () => c.procs[1].text("m2", "b"));
	assert.deepEqual([idleInfos[1].plan, idleInfos[1].reason], ["restart", "exit"]);
});

test("onTurn: a tool-result request whose parked call is gone restarts with reason `missing-tool-call`", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs, hosts } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	hosts[0].expected = [];
	const result: PiMessage = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 3 };
	await turn(session, [u("lee"), (e1.at(-1) as any).message, result], () => procs[1].text("m2", "ok"));
	assert.deepEqual([infos[1].plan, infos[1].reason], ["restart", "missing-tool-call"]);
});

test("onTurn is called exactly once per settled stream(); a throwing observer never breaks the turn", async () => {
	let calls = 0;
	const { session, procs } = setup({ onTurn: () => { calls++; throw new Error("observer"); } });
	const events = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	assert.equal(events.at(-1)!.type, "done");
	assert.equal(calls, 1);
});


// --- keep the prompt cache across process losses (T15 / S9) ---
/** Run one turn, then deliver claude's `result` line for it, as claude does after every answer. */
async function answered(session: ReturnType<typeof createSession>, proc: () => FakeProc, messages: PiMessage[], extra: Partial<typeof base> = {}, id = "m1") {
	const events = await turn(session, messages, () => proc().text(id, "r-" + id), extra);
	proc().emit({ type: "result", subtype: "success", is_error: false });
	return (events.at(-1) as any).message as PiMessage;
}

test("abort writes one interrupt control request (request_id, subtype interrupt) and does not kill claude", async () => {
	const { session, procs } = setup();
	const ac = new AbortController();
	const events = await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	assert.equal((events.at(-1) as any).reason, "aborted");
	assert.equal(procs[0].killed, false);
	const sent = interrupts(procs[0]);
	assert.equal(sent.length, 1);
	assert.equal(typeof sent[0].request_id, "string");
	assert.ok(sent[0].request_id.length > 0);
	assert.deepEqual(sent[0].request, { subtype: "interrupt" });
	assert.deepEqual(Object.keys(sent[0]).sort(), ["request", "request_id", "type"]);
});

test("after an interrupt the next stream() waits for claude's result, then sends the new message on the same process", async () => {
	const { session, procs } = setup();
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	const events: RelayEvent[] = [];
	const next = session.stream({ ...base, messages: [u("hola"), abortedMessage(), u("otra")] }, (e) => events.push(e));
	await tick(); await tick();
	assert.equal(procs[0].written.length, 2, "user line + interrupt only: nothing is written while draining");
	procs[0].emit({ type: "control_response", response: { subtype: "success", request_id: interrupts(procs[0])[0].request_id } });
	await tick();
	assert.equal(procs[0].written.length, 2, "the control_response alone does not end the drain");
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	await tick();
	assert.deepEqual(procs[0].written.at(-1), userLineOf("otra"));
	procs[0].text("m2", "listo");
	await next;
	assert.equal(procs.length, 1, "no new process");
	assert.equal(procs[0].killed, false);
	assert.equal((events.at(-1) as any).message.content[0].text, "listo");
});

test("an interrupt claude ignored (it finishes the turn normally) ends the drain too; the process is reused", async () => {
	const { session, procs } = setup();
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	const next = session.stream({ ...base, messages: [u("hola"), abortedMessage(), u("otra")] }, () => {});
	await tick();
	procs[0].text("ignored", "late answer to the aborted turn"); // arrives while draining: dropped
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await tick();
	assert.deepEqual(procs[0].written.at(-1), userLineOf("otra"));
	procs[0].text("m2", "ok");
	await next;
	assert.equal(procs.length, 1);
});

test("the interrupt timeout is 5 s: no result in time kills claude and the request restarts it (reason `abort`), resuming its session", async () => {
	const infos: TurnInfo[] = [];
	const timers = new ManualTimers();
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)), timers });
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	assert.deepEqual(timers.live().map((t) => t.ms), [5000]);
	const next = session.stream({ ...base, messages: [u("hola"), abortedMessage(), u("otra")] }, () => {});
	await tick();
	assert.equal(procs.length, 1);
	timers.fire();
	await tick();
	assert.equal(procs[0].killed, true);
	assert.equal(procs.length, 2);
	assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
	assert.deepEqual(procs[1].written, [userLineOf("otra")]);
	procs[1].text("m2", "ok");
	await next;
	assert.deepEqual([infos[1].plan, infos[1].reason, infos[1].resumed], ["restart", "abort", true]);
});

test("a result that arrives in time cancels the interrupt timer: no kill when it fires later", async () => {
	const timers = new ManualTimers();
	const { session, procs } = setup({ timers });
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	timers.fire();
	await tick();
	assert.equal(procs[0].killed, false);
});

test("claude exiting while draining is an `exit` loss, not a hang: the next turn restarts and resumes", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)), timers: new ManualTimers() });
	const ac = new AbortController();
	await turn(session, [u("hola")], () => { procs[0].emit(MESSAGE_START); ac.abort(); }, { signal: ac.signal });
	const next = session.stream({ ...base, messages: [u("hola"), abortedMessage(), u("otra")] }, () => {});
	await tick();
	procs[0].exit(1, "");
	await tick();
	procs[1].text("m2", "ok");
	await next;
	assert.deepEqual([infos[1].plan, infos[1].reason, infos[1].resumed], ["restart", "exit", true]);
});

test("an abort tool phase (Pi's next request arrives already aborted while claude waits on parked calls) fails the parked calls and interrupts claude", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const ac = new AbortController(); ac.abort();
	const events: RelayEvent[] = [];
	await session.stream({ ...base, messages: [u("lee"), assistant, { ...toolResult("toolu_1"), isError: true, content: [{ type: "text", text: "Operation aborted" }] }], signal: ac.signal }, (e) => events.push(e));
	assert.equal((events.at(-1) as any).reason, "aborted");
	assert.deepEqual(hosts[0].failed, ["Request was aborted"]);
	assert.equal(hosts[0].resolved.length, 0);
	assert.equal(interrupts(procs[0]).length, 1);
	assert.equal(procs[0].killed, false);
	// Pi's next request: tool results, the aborted assistant message, the new user message.
	const next = session.stream({ ...base, messages: [u("lee"), assistant, { ...toolResult("toolu_1"), isError: true, content: [{ type: "text", text: "Operation aborted" }] }, abortedMessage(), u("otra")] }, () => {});
	await tick();
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	await tick();
	assert.deepEqual(procs[0].written.at(-1), userLineOf("otra"));
	procs[0].text("m2", "ok");
	await next;
	assert.equal(procs.length, 1);
});

test("an already-aborted request with nothing in flight writes no interrupt and never touches the process", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const ac = new AbortController(); ac.abort();
	await session.stream({ ...base, messages: [u("hola"), a1, u("otra")], signal: ac.signal }, () => {});
	assert.equal(interrupts(procs[0]).length, 0);
	assert.equal(procs[0].killed, false);
});

for (const [label, change] of [
	["model", { model: "claude-opus-5-5" }],
	["effort", { effort: "high" }],
	["tools", { tools: [{ name: "bash", description: "Run", parameters: { type: "object" } }] }],
	["credential", { apiKey: "sk-ant-oat01-other" }],
] as [string, Partial<typeof base>][]) {
	test(`restart for ${label}: resumes claude's session with the new settings and writes only the new message`, async () => {
		const infos: TurnInfo[] = [];
		const removed: string[][] = [];
		const { session, procs, hosts } = setup({ onTurn: (i) => infos.push(structuredClone(i)), removeTranscripts: (ids) => removed.push(ids) });
		const a1 = await answered(session, () => procs[0], [u("hola")]);
		await turn(session, [u("hola"), a1, u("sigue")], () => procs[1].text("m2", "b"), change);
		assert.equal(procs.length, 2);
		assert.equal(procs[0].killed, true);
		assert.equal(hosts[1].started, true);
		assert.ok(procs[0].opts.sessionId, "the first process was started with a session id");
		assert.equal(procs[0].opts.resume, undefined);
		assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
		assert.equal(procs[1].opts.sessionId, undefined);
		assert.deepEqual(procs[1].written, [userLineOf("sigue")]);
		assert.equal(JSON.stringify(procs[1].written).includes("conversation_history"), false);
		assert.deepEqual([infos[1].plan, infos[1].reason, infos[1].resumed], ["restart", label === "credential" ? "credential" : label, true]);
		assert.deepEqual(removed, [], "a resumed session keeps its transcript");
	});
}

test("the new settings reach the resumed process (model, effort, tools, credential)", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	await turn(session, [u("hola"), a1, u("sigue")], () => procs[1].text("m2", "b"), { model: "claude-opus-5-5", effort: "high", apiKey: "sk-ant-oat01-other" });
	assert.equal(procs[1].opts.model, "claude-opus-5-5");
	assert.equal(procs[1].opts.effort, "high");
	assert.deepEqual(procs[1].opts.credential, { kind: "oauth", value: "sk-ant-oat01-other" });
});

test("a changed system prompt cannot be applied on resume (claude keeps the session's original one): flattened replay with a fresh session id, the old transcript retired", async () => {
	const infos: TurnInfo[] = [];
	const removed: string[][] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)), removeTranscripts: (ids) => removed.push(ids) });
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	await turn(session, [u("hola"), a1, u("sigue")], () => procs[1].text("m2", "b"), { systemPrompt: "SYS2" });
	assert.equal(procs[1].opts.resume, undefined);
	assert.ok(procs[1].opts.sessionId && procs[1].opts.sessionId !== procs[0].opts.sessionId);
	assert.match(procs[1].written[0].message.content[0].text, /^<conversation_history>/);
	assert.deepEqual([infos[1].reason, infos[1].resumed], ["system-prompt", false]);
	assert.deepEqual(removed, [[procs[0].opts.sessionId]]);
});

test("diverged history (compaction / branch switch) never resumes: flattened replay", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	await answered(session, () => procs[0], [u("hola")]);
	await turn(session, [u("resumen"), u("sigue")], () => procs[1].text("m2", "b"), { apiKey: "sk-ant-oat01-other" });
	assert.equal(procs[1].opts.resume, undefined);
	assert.match(procs[1].written[0].message.content[0].text, /^<conversation_history>/);
	assert.deepEqual([infos[1].reason, infos[1].resumed], ["credential", false]);
});

test("a tool call pending in claude never resumes: flattened replay", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	await turn(session, [u("lee"), assistant, toolResult("toolu_1")], () => procs[1].text("m2", "ok"), { model: "claude-opus-5-5" });
	assert.equal(procs[1].opts.resume, undefined);
	assert.match(procs[1].written[0].message.content[0].text, /<tool_result id="toolu_1" name="read">\ndata\n<\/tool_result>/);
	assert.deepEqual([infos[1].reason, infos[1].resumed], ["model", false]);
});

test("a pending tool call lost with its process (exit while parked) is replayed flattened, not resumed", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	procs[0].exit(1, "");
	await turn(session, [u("lee"), assistant, toolResult("toolu_1")], () => procs[1].text("m2", "ok"));
	assert.equal(procs[1].opts.resume, undefined);
	assert.match(procs[1].written[0].message.content[0].text, /^<conversation_history>/);
	assert.deepEqual([infos[1].reason, infos[1].resumed], ["exit", false]);
});

test("an idle process exit resumes (reason `exit`); an error result resumes with the failed message re-sent (reason `error`)", async () => {
	const exitInfos: TurnInfo[] = [];
	const a = setup({ onTurn: (i) => exitInfos.push(structuredClone(i)) });
	const a1 = await answered(a.session, () => a.procs[0], [u("hola")]);
	a.procs[0].exit(137, "");
	await turn(a.session, [u("hola"), a1, u("sigue")], () => a.procs[1].text("m2", "b"));
	assert.equal(a.procs[1].opts.resume, a.procs[0].opts.sessionId);
	assert.deepEqual(a.procs[1].written, [userLineOf("sigue")]);
	assert.deepEqual([exitInfos[1].reason, exitInfos[1].resumed], ["exit", true]);

	const errInfos: TurnInfo[] = [];
	const b = setup({ onTurn: (i) => errInfos.push(structuredClone(i)) });
	const b1 = await answered(b.session, () => b.procs[0], [u("hola")]);
	await turn(b.session, [u("hola"), b1, u("sigue")], () => b.procs[0].emit({ type: "result", subtype: "success", is_error: true, result: "API Error" }));
	assert.equal(errInfos[1].stopReason, "error");
	await turn(b.session, [u("hola"), b1, u("sigue")], () => b.procs[1].text("m3", "ok")); // Pi's retry: same messages
	assert.equal(b.procs[1].opts.resume, b.procs[0].opts.sessionId);
	assert.deepEqual(b.procs[1].written, [userLineOf("sigue")]);
	assert.deepEqual([errInfos[2].reason, errInfos[2].resumed], ["error", true]);
});

test("a process lost before any turn completed has no session to resume: flattened replay", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	await turn(session, [u("hola")], () => procs[0].exit(1, "boom"));
	await turn(session, [u("hola")], () => procs[1].text("m1", "ok"));
	assert.equal(procs[1].opts.resume, undefined);
	assert.equal(infos[1].resumed, false);
});

test("a resumed process that exits before answering falls back once to the flattened replay in the same request", async () => {
	const infos: TurnInfo[] = [];
	const removed: string[][] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)), removeTranscripts: (ids) => removed.push(ids) });
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: [u("hola"), a1, u("sigue")] }, (e) => events.push(structuredClone(e)));
	await tick();
	assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
	procs[1].exit(1, "No conversation found with session ID");
	await tick();
	assert.equal(procs.length, 3);
	assert.equal(procs[2].opts.resume, undefined);
	assert.ok(procs[2].opts.sessionId);
	assert.match(procs[2].written[0].message.content[0].text, /^<conversation_history>/);
	procs[2].text("m2", "ok");
	await p;
	assert.equal(events.at(-1)!.type, "done");
	assert.equal(events.filter((e) => e.type === "error").length, 0);
	assert.deepEqual([infos[1].plan, infos[1].reason, infos[1].resumed], ["restart", "credential", false]);
	assert.deepEqual(removed, [[procs[0].opts.sessionId]]);
});

test("a resumed process answering with an error result before it ever started (claude: No conversation found) also falls back", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const p = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: [u("hola"), a1, u("sigue")] }, () => {});
	await tick();
	procs[1].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	procs[1].exit(1, "No conversation found with session ID: x");
	await tick();
	assert.equal(procs.length, 3);
	assert.equal(procs[1].killed, true);
	assert.match(procs[2].written[0].message.content[0].text, /^<conversation_history>/);
	procs[2].text("m2", "ok");
	await p;
});

test("the fallback happens once: if the flattened process dies too the request fails (no loop)", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: [u("hola"), a1, u("sigue")] }, (e) => events.push(e));
	await tick();
	procs[1].exit(1, "");
	await tick();
	procs[2].exit(1, "boom");
	await p;
	assert.equal(procs.length, 3);
	assert.equal((events.at(-1) as any).type, "error");
	assert.match((events.at(-1) as any).error.errorMessage, /claude exited with code 1: boom/);
});

test("a resumed process that already started (init seen) and then dies is an ordinary failure, not a fallback", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: [u("hola"), a1, u("sigue")] }, (e) => events.push(e));
	await tick();
	procs[1].emit(initLine(UUID_X));
	procs[1].exit(1, "crashed");
	await p;
	assert.equal(procs.length, 2);
	assert.equal((events.at(-1) as any).type, "error");
});

test("the session id is tracked from claude's init line; a resumed process may report a new one and the next resume uses it", async () => {
	const { session, procs } = setup();
	procs; // created lazily
	const e1 = await turn(session, [u("hola")], () => { procs[0].emit(initLine(UUID_X)); procs[0].text("m1", "a"); });
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const a1 = (e1.at(-1) as any).message;
	const e2 = await turn(session, [u("hola"), a1, u("dos")], () => { procs[1].emit(initLine(UUID_Y)); procs[1].text("m2", "b"); }, { effort: "high" });
	assert.equal(procs[1].opts.resume, UUID_X);
	procs[1].emit({ type: "result", subtype: "success", is_error: false });
	const a2 = (e2.at(-1) as any).message;
	await turn(session, [u("hola"), a1, u("dos"), a2, u("tres")], () => procs[2].text("m3", "c"), { effort: "low" });
	assert.equal(procs[2].opts.resume, UUID_Y);
});

test("an init line with a malformed session id is ignored (it becomes a file name later)", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("hola")], () => { procs[0].emit(initLine("../../etc/passwd")); procs[0].text("m1", "a"); });
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await turn(session, [u("hola"), (e1.at(-1) as any).message, u("dos")], () => procs[1].text("m2", "b"), { effort: "high" });
	assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
});

test("close() removes every transcript the session wrote (spawn id and ids claude reported), once", async () => {
	const removed: string[][] = [];
	const { session, procs } = setup({ removeTranscripts: (ids) => removed.push([...ids].sort()) });
	const e1 = await turn(session, [u("hola")], () => { procs[0].emit(initLine(UUID_X)); procs[0].text("m1", "a"); });
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const spawnId = procs[0].opts.sessionId!;
	await turn(session, [u("hola"), (e1.at(-1) as any).message, u("dos")], () => { procs[1].emit(initLine(UUID_Y)); procs[1].text("m2", "b"); }, { effort: "high" });
	assert.deepEqual(removed, []);
	await session.close();
	assert.deepEqual(removed, [[spawnId, UUID_X, UUID_Y].sort()]);
	await session.close();
	assert.equal(removed.length, 1, "a second close removes nothing more");
});

test("a throwing transcript remover never breaks close()", async () => {
	const { session, procs } = setup({ removeTranscripts: () => { throw new Error("EACCES"); } });
	await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	await session.close();
	assert.equal(procs[0].killed, true);
});

test("throwaway sessions keep --no-session-persistence semantics: no session id, never resumed, nothing to remove", async () => {
	const removed: string[][] = [];
	const { session, procs } = setup({ removeTranscripts: (ids) => removed.push(ids) });
	const events = await turn(session, [u("hola")], () => procs[0].exit(1, "boom"), { throwaway: true } as any);
	assert.equal((events.at(-1) as any).type, "error");
	assert.equal(procs[0].opts.sessionId, undefined);
	assert.equal(procs[0].opts.resume, undefined);
	await turn(session, [u("hola")], () => procs[1].text("m1", "ok"), { throwaway: true } as any);
	assert.equal(procs[1].opts.resume, undefined);
	assert.equal(procs[1].opts.sessionId, undefined);
	await session.close();
	assert.deepEqual(removed.flat(), []);
});

test("a throwaway request on an idle exit is replayed, never resumed", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")], { throwaway: true } as any);
	procs[0].exit(1, "");
	await turn(session, [u("hola"), a1, u("sigue")], () => procs[1].text("m2", "b"), { throwaway: true } as any);
	assert.equal(procs[1].opts.resume, undefined);
	assert.match(procs[1].written[0].message.content[0].text, /^<conversation_history>/);
});

test("buildClaudeArgs: a new relay session starts with --session-id (persistence on), a restart with --resume, a throwaway with --no-session-persistence", () => {
	const o = { model: "m", effort: "off", toolNames: ["read"], systemPromptFile: "s", mcpConfigFile: "c" };
	const fresh = buildClaudeArgs({ ...o, sessionId: UUID_X });
	assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), ["--session-id", UUID_X]);
	assert.ok(!fresh.includes("--no-session-persistence") && !fresh.includes("--resume"));
	const resumed = buildClaudeArgs({ ...o, resume: UUID_Y });
	assert.deepEqual(resumed.slice(resumed.indexOf("--resume"), resumed.indexOf("--resume") + 2), ["--resume", UUID_Y]);
	assert.ok(!resumed.includes("--no-session-persistence") && !resumed.includes("--session-id"));
	const throwaway = buildClaudeArgs(o);
	assert.ok(throwaway.includes("--no-session-persistence") && !throwaway.includes("--session-id") && !throwaway.includes("--resume"));
});

test("the request's cost function prices the assistant message's usage", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].text("m1", "ok"), { cost: (usage: any) => { usage.cost.total = 7; } } as any);
	assert.equal((events.at(-1) as any).message.usage.cost.total, 7);
});

test("after a resumed process fails its turn, the retry does not resume again: it replays the transcript in a fresh session", async () => {
	const { session, procs } = setup();
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	const history = [u("hola"), a1, u("sigue")];
	const first = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: history }, () => {});
	await tick();
	assert.equal(procs[1].opts.resume, procs[0].opts.sessionId);
	procs[1].emit(initLine(UUID_X));
	procs[1].emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 400 invalid history" });
	await first;
	const events: RelayEvent[] = [];
	const retry = session.stream({ ...base, apiKey: "sk-ant-oat01-other", messages: history }, (e) => events.push(e));
	await tick();
	assert.equal(procs.length, 3);
	assert.equal(procs[2].opts.resume, undefined, "a poisoned session must not be resumed again");
	assert.match(procs[2].written[0].message.content[0].text, /^<conversation_history>/);
	procs[2].text("m2", "ok");
	await retry;
	assert.equal(events.at(-1)!.type, "done");
});

test("closeNow is synchronous: the process is killed and the transcripts are removed before it returns", async () => {
	const removed: string[][] = [];
	const { session, procs } = setup({ removeTranscripts: (ids) => removed.push(ids) });
	await answered(session, () => procs[0], [u("hola")]);
	session.closeNow();
	assert.equal(procs[0].killed, true);
	assert.deepEqual(removed, [[procs[0].opts.sessionId]]);
});

test("close waits for claude to be gone before removing its transcripts (a dying claude still flushes them)", async () => {
	const order: string[] = [];
	const { session, procs } = setup({ removeTranscripts: () => order.push("removed") });
	await answered(session, () => procs[0], [u("hola")]);
	let die!: () => void;
	procs[0].gone = new Promise<void>((r) => { die = r; }).then(() => { order.push("gone"); });
	const closing = session.close();
	await tick();
	assert.deepEqual(order, [], "nothing removed while claude is still alive");
	die();
	await closing;
	assert.deepEqual(order, ["gone", "removed"]);
});

test("closeNow kills claude hard so it cannot write its transcript after the removal", async () => {
	const { session, procs } = setup({ removeTranscripts: () => {} });
	await answered(session, () => procs[0], [u("hola")]);
	session.closeNow();
	assert.equal(procs[0].hardKilled, true);
});

test("a user message that arrives with tool results is written before the results, so claude folds it into the same turn", async () => {
	const timers = new ManualTimers();
	const { session, procs, hosts } = setup({ timers });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, messages: [u("lee"), assistant, toolResult("toolu_1"), u("y termina con BANANA")] }, (e) => events.push(structuredClone(e)));
	await tick();
	const steer = procs[0].written.at(-1);
	assert.match(steer.uuid, /^[0-9a-f-]{36}$/, "the line carries an id so claude's replay can acknowledge it");
	assert.deepEqual({ type: steer.type, message: steer.message }, { type: "user", message: { role: "user", content: [{ type: "text", text: "y termina con BANANA" }] } });
	assert.deepEqual(hosts[0].resolved, [], "the tool result waits until claude has read the message");
	assert.deepEqual(timers.live().map((t) => t.ms), [STEER_LEAD_MS]);
	timers.fire();
	await tick();
	assert.deepEqual(hosts[0].resolved.map((r) => r[0]), ["toolu_1"]);
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid, message: steer.message }); // claude took the line into the running turn
	procs[0].text("m2", "data BANANA");
	await p;
	assert.equal((events.at(-1) as any).message.content[0].text, "data BANANA");
	// claude answers the whole turn (first message, tool, folded message) with ONE result: the next turn is a plain send.
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const a2 = (events.at(-1) as any).message;
	const e3 = await turn(session, [u("lee"), assistant, toolResult("toolu_1"), u("y termina con BANANA"), a2, u("otra")], () => procs[0].text("m3", "ok"));
	assert.equal(procs.length, 1);
	assert.equal((e3.at(-1) as any).message.content[0].text, "ok");
});

test("a turn nobody asked for (claude answering a queued message on its own) is not attributed to the next request", async () => {
	const timers = new ManualTimers();
	const { session, procs } = setup({ timers });
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	// claude starts another turn by itself.
	procs[0].emit({ type: "stream_event", event: { type: "message_start", message: { id: "stray", usage: {} } } });
	const events: RelayEvent[] = [];
	const p = session.stream({ ...base, messages: [u("hola"), a1, u("sigue")] }, (e) => events.push(structuredClone(e)));
	await tick();
	const userLines = () => procs[0].written.filter((w) => w.type === "user").length;
	assert.equal(userLines(), 1, "the new message waits for the stray turn to end");
	procs[0].emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
	procs[0].emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stray text" } } });
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await tick();
	assert.equal(userLines(), 2);
	procs[0].text("m2", "real answer");
	await p;
	assert.equal((events.at(-1) as any).message.content[0].text, "real answer");
	assert.ok(!JSON.stringify(events).includes("stray text"));
});

test("error text never shows any Anthropic key or loopback MCP token, even ones the session does not know", async () => {
	const { session, procs } = setup();
	const events = await turn(session, [u("hola")], () => procs[0].exit(1, "auth failed for sk-ant-oat01-SOME-other_token123 at http://127.0.0.1:5555/0123456789abcdef0123456789abcdef and sk-ant-api03-partial\n"));
	const msg = (events.at(-1) as any).error.errorMessage as string;
	assert.equal(msg, "claude exited with code 1: auth failed for [redacted] at http://127.0.0.1:5555/[redacted] and [redacted]");
});

test("closeNow also hard-kills a claude that was stopped earlier and is still exiting", async () => {
	const { session, procs } = setup({ removeTranscripts: () => {} });
	const a1 = await answered(session, () => procs[0], [u("hola")]);
	procs[0].gone = new Promise<void>(() => {}); // never finishes exiting
	// A model change replaces the process: the old one is soft-killed.
	await answered(session, () => procs[1], [u("hola"), a1, u("sigue")], { model: "claude-opus-5-5" }, "m2");
	assert.equal(procs[0].killed, true);
	assert.equal(procs[0].hardKilled, false);
	session.closeNow();
	assert.equal(procs[0].hardKilled, true);
	assert.equal(procs[1].hardKilled, true);
});

test("a steering line claude did not fold into the turn is answered as its own turn, which is discarded and never reaches the next request", async () => {
	const timers = new ManualTimers();
	const { session, procs } = setup({ timers });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const events2: RelayEvent[] = [];
	const p2 = session.stream({ ...base, messages: [u("lee"), assistant, toolResult("toolu_1"), u("extra")] }, (e) => events2.push(structuredClone(e)));
	await tick();
	timers.fire();
	await tick();
	procs[0].text("m2", "answer without the extra message");
	await p2;
	const a2 = (events2.at(-1) as any).message;
	// The turn ends and claude never acknowledged the line: it is still queued and will be answered on its own.
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	const events3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: [u("lee"), assistant, toolResult("toolu_1"), u("extra"), a2, u("otra")] }, (e) => events3.push(structuredClone(e)));
	await tick();
	procs[0].text("stray", "answer to the extra message");
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await tick();
	assert.equal(events3.filter((e) => e.type === "done" || e.type === "error").length, 0, "the stray answer does not settle the new request");
	procs[0].text("m3", "answer to otra");
	await p3;
	assert.equal((events3.at(-1) as any).message.content[0].text, "answer to otra");
	assert.ok(!JSON.stringify(events3).includes("answer to the extra message"));
	assert.equal(procs.length, 1);
});

test("an abort while a steering line is still unacknowledged kills claude instead of interrupting it (the queued line must not survive)", async () => {
	const timers = new ManualTimers();
	const { session, procs, hosts } = setup({ timers });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const ac = new AbortController();
	const p = session.stream({ ...base, signal: ac.signal, messages: [u("lee"), assistant, toolResult("toolu_1"), u("extra")] }, () => {});
	await tick();
	ac.abort();
	timers.fire();
	await p;
	assert.equal(procs[0].killed, true);
	assert.ok(!procs[0].written.some((w) => w.type === "control_request"));
	assert.deepEqual(hosts[0].resolved, []);
});

// Steering-line accounting across event orderings.

const RESULT = { type: "result", subtype: "success", is_error: false };
const lastText = (ev: RelayEvent[]) => (ev.at(-1) as any).message?.content?.[0]?.text;
const settled = (ev: RelayEvent[]) => ev.some((e) => e.type === "done" || e.type === "error");
async function steered(timers: ManualTimers, procs: FakeProc[], session: any) {
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const msgs2 = [u("lee"), assistant, toolResult("toolu_1"), u("extra")];
	const ev2: RelayEvent[] = [];
	const p2 = session.stream({ ...base, messages: msgs2 }, (e: any) => ev2.push(structuredClone(e)));
	await tick(); timers.fire(); await tick();
	return { assistant, msgs2, ev2, p2, steer: procs[0].written.at(-1) };
}

test("steering not folded: a next request written before the turn's result still gets its own answer", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].text("m2", "A-answer"); await p2;
	const a2 = (ev2.at(-1) as any).message;
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: [...msgs2, a2, u("otra")] }, (e) => ev3.push(structuredClone(e)));
	await tick();
	procs[0].emit(RESULT); // result #1, steer unacked
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid });
	procs[0].text("stray", "stray-answer"); procs[0].emit(RESULT);
	await tick(); assert.equal(settled(ev3), false);
	procs[0].emit({ type: "user", isReplay: true });
	procs[0].text("m3", "B-answer"); procs[0].emit(RESULT);
	await p3; assert.equal(lastText(ev3), "B-answer");
});

test("steering not folded: a next request written while the stray turn streams gets its own answer", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].text("m2", "A-answer"); await p2;
	const a2 = (ev2.at(-1) as any).message;
	procs[0].emit(RESULT);
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid });
	procs[0].emit({ type: "stream_event", event: { type: "message_start", message: { id: "s", usage: {} } } });
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: [...msgs2, a2, u("otra")] }, (e) => ev3.push(structuredClone(e)));
	await tick();
	procs[0].text("stray", "stray-answer"); procs[0].emit(RESULT);
	await tick(); assert.equal(settled(ev3), false);
	procs[0].text("m3", "B-answer"); procs[0].emit(RESULT);
	await p3; assert.equal(lastText(ev3), "B-answer");
});

test("steering not folded: with no request waiting the stray turn is drained and a later request works", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, ev2, p2 } = await steered(timers, procs, session);
	procs[0].text("m2", "A-answer"); await p2;
	const a2 = (ev2.at(-1) as any).message;
	procs[0].emit(RESULT); procs[0].text("stray", "x"); procs[0].emit(RESULT); await tick();
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: [...msgs2, a2, u("otra")] }, (e) => ev3.push(structuredClone(e)));
	await tick(); procs[0].text("m3", "B"); await p3; assert.equal(lastText(ev3), "B");
});

test("two steering lines left unacknowledged are both discarded as stray turns", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { assistant, msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].toolUse("m2", "toolu_2", "read", { path: "b" }); await p2;
	const a2 = (ev2.at(-1) as any).message;
	const msgs3 = [...msgs2, a2, toolResult("toolu_2"), u("extra2")];
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: msgs3 }, (e) => ev3.push(structuredClone(e)));
	await tick(); timers.fire(); await tick();
	procs[0].text("m3", "A-final"); await p3;
	const a3 = (ev3.at(-1) as any).message;
	procs[0].emit(RESULT); // unfolded: both lines still queued
	const ev4: RelayEvent[] = [];
	const p4 = session.stream({ ...base, messages: [...msgs3, a3, u("otra")] }, (e) => ev4.push(structuredClone(e)));
	await tick();
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid }); procs[0].text("s1", "stray1"); procs[0].emit(RESULT);
	procs[0].emit({ type: "user", isReplay: true, uuid: procs[0].written.at(-2)?.uuid }); procs[0].text("s2", "stray2"); procs[0].emit(RESULT);
	await tick(); assert.equal(settled(ev4), false, "stray answers must not settle B");
	procs[0].emit({ type: "user", isReplay: true }); procs[0].text("m4", "B-answer"); procs[0].emit(RESULT);
	await p4; assert.equal(lastText(ev4), "B-answer");
});

test("an error result while a steering line is unacknowledged fails the turn and the next request starts clean", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, p2, ev2 } = await steered(timers, procs, session);
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" });
	await p2; assert.equal((ev2.at(-1) as any).type, "error");
	const ev3 = await turn(session, [...msgs2, (ev2.at(-1) as any).error ?? (ev2.at(-1) as any).message, u("otra")], () => procs[1].text("n", "ok"));
	assert.equal(lastText(ev3), "ok");
});

test("aborting a request while a stray steering turn is discarded does not hang the next request", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].text("m2", "A"); await p2;
	const a2 = (ev2.at(-1) as any).message;
	procs[0].emit(RESULT); // discarding, owed 1
	const ac = new AbortController();
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, signal: ac.signal, messages: [...msgs2, a2, u("otra")] }, (e) => ev3.push(structuredClone(e)));
	await tick(); ac.abort(); await p3;
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid }); procs[0].text("stray", "s"); procs[0].emit(RESULT); // stray result
	procs[0].text("b", "b"); procs[0].emit(RESULT); // aborted B's own turn
	await tick();
	const ev4: RelayEvent[] = [];
	const p4 = session.stream({ ...base, messages: [...msgs2, a2, u("otra"), abortedMessage(), u("c")] }, (e) => ev4.push(structuredClone(e)));
	await tick(); procs[0].text("c", "C"); await p4; assert.equal(lastText(ev4), "C");
});

test("after an abort with an unacknowledged steering line the next request replays the history in a fresh process", async () => {
	const turns: TurnInfo[] = [];
	const timers = new ManualTimers(); const { session, procs } = setup({ timers, onTurn: (i) => turns.push(i) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const assistant = (e1.at(-1) as any).message;
	const ac = new AbortController();
	const p = session.stream({ ...base, signal: ac.signal, messages: [u("lee"), assistant, toolResult("toolu_1"), u("extra")] }, () => {});
	await tick(); ac.abort(); timers.fire(); await p;
	const ab = abortedMessage();
	const ev: RelayEvent[] = [];
	const pn = session.stream({ ...base, messages: [u("lee"), assistant, toolResult("toolu_1"), u("extra"), ab, u("nuevo")] }, (e) => ev.push(structuredClone(e)));
	for (let i = 0; i < 20; i++) await tick();
	procs[1].text("n", "ok"); await pn;
	assert.equal(lastText(ev), "ok");
});

test("three steering lines left unacknowledged across three tool rounds are all discarded", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { assistant, msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].toolUse("m2", "toolu_2", "read", { path: "b" }); await p2;
	const a2 = (ev2.at(-1) as any).message;
	const msgs3 = [...msgs2, a2, toolResult("toolu_2"), u("extra2")];
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: msgs3 }, (e: any) => ev3.push(structuredClone(e)));
	await tick(); timers.fire(); await tick();
	procs[0].toolUse("m3", "toolu_3", "read", { path: "c" }); await p3;
	const a3 = (ev3.at(-1) as any).message;
	const msgs4 = [...msgs3, a3, toolResult("toolu_3"), u("extra3")];
	const ev4: RelayEvent[] = [];
	const p4 = session.stream({ ...base, messages: msgs4 }, (e: any) => ev4.push(structuredClone(e)));
	await tick(); timers.fire(); await tick();
	procs[0].text("m4", "F"); await p4;
	const a4 = (ev4.at(-1) as any).message;
	procs[0].emit(RESULT);
	const ev5: RelayEvent[] = [];
	const p5 = session.stream({ ...base, messages: [...msgs4, a4, u("otra")] }, (e) => ev5.push(structuredClone(e)));
	await tick();
	for (let i = 0; i < 3; i++) { procs[0].text("s"+i, "stray"+i); procs[0].emit(RESULT); await tick(); assert.equal(settled(ev5), false); }
	procs[0].text("b", "B-answer"); procs[0].emit(RESULT);
	await p5; assert.equal(lastText(ev5), "B-answer");
});

test("an older steering line folded in a later tool round is not discarded; only the unacknowledged one is", async () => {
	const timers = new ManualTimers(); const { session, procs } = setup({ timers });
	const { msgs2, ev2, p2, steer } = await steered(timers, procs, session);
	procs[0].toolUse("m2", "toolu_2", "read", { path: "b" }); await p2;
	const a2 = (ev2.at(-1) as any).message;
	const msgs3 = [...msgs2, a2, toolResult("toolu_2"), u("extra2")];
	const ev3: RelayEvent[] = [];
	const p3 = session.stream({ ...base, messages: msgs3 }, (e: any) => ev3.push(structuredClone(e)));
	await tick(); timers.fire(); await tick();
	procs[0].emit({ type: "user", isReplay: true, uuid: steer.uuid }); // old line folded late
	procs[0].text("m3", "F"); await p3;
	const a3 = (ev3.at(-1) as any).message;
	procs[0].emit(RESULT);
	const ev4: RelayEvent[] = [];
	const p4 = session.stream({ ...base, messages: [...msgs3, a3, u("otra")] }, (e) => ev4.push(structuredClone(e)));
	await tick();
	procs[0].text("s", "stray"); procs[0].emit(RESULT); await tick(); assert.equal(settled(ev4), false);
	procs[0].text("b", "B-answer"); procs[0].emit(RESULT);
	await p4; assert.equal(lastText(ev4), "B-answer");
});

// --- long tool calls: claude giving up on a parked call never hangs Pi (fix/long-tool-calls) ---
const readResult = (id: string, text = "data"): PiMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 });

test("claude giving up on a parked call stops it at once; the late result restarts with a replay instead of hanging", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs, hosts } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("revisa")], () => procs[0].toolUse("m1", "toolu_long", "read", { path: "a" }));
	assert.equal((e1.at(-1) as any).message.stopReason, "toolUse");
	hosts[0].drop("toolu_long"); // 300 s later: claude's MCP client cut the call while Pi still runs the tool
	assert.equal(procs[0].killed, true, "claude is stopped at once: no turn of its own runs without the result");
	assert.equal(hosts[0].failed.length, 1, "other parked calls are answered");
	const e2 = await turn(session, [u("revisa"), (e1.at(-1) as any).message, readResult("toolu_long", "approved")], () => procs[1].text("m2", "listo"));
	assert.equal(procs.length, 2);
	assert.equal(hosts[1].resolved.length, 0, "nothing is delivered into a call nobody waits for");
	assert.match(procs[1].written[0].message.content[0].text, /<tool_result id="toolu_long" name="read">\napproved\n<\/tool_result>/);
	assert.equal((e2.at(-1) as any).type, "done");
	assert.equal((e2.at(-1) as any).message.content[0].text, "listo");
	assert.deepEqual([infos[1].plan, infos[1].reason, infos[1].resumed], ["restart", "missing-tool-call", false]);
});

test("claude ending its turn while Pi still owes a tool result stops it; the result restarts instead of hanging", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("revisa")], () => procs[0].toolUse("m1", "toolu_long", "read", { path: "a" }));
	procs[0].text("m-stray", "the tool did not answer, I stop here"); // nobody listens: no active request
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	assert.equal(procs[0].killed, true);
	const e2 = await turn(session, [u("revisa"), (e1.at(-1) as any).message, readResult("toolu_long")], () => procs[1].text("m2", "listo"));
	assert.equal(procs.length, 2);
	assert.equal(hosts[0].resolved.length, 0);
	assert.equal((e2.at(-1) as any).message.content[0].text, "listo");
});

test("a normal result after the tool results were answered does not stop claude", async () => {
	const { session, procs } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const e2 = await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1")], () => procs[0].text("m2", "ok"));
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	assert.equal(procs[0].killed, false);
	await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1"), (e2.at(-1) as any).message, u("y?")], () => procs[0].text("m3", "b"));
	assert.equal(procs.length, 1);
});

test("claude giving up while the results request waits for its answer restarts within that same request", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs, hosts } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const e2 = await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1")], () => {
		hosts[0].drop("toolu_1"); // the result was handed over just as claude's client cut the call
		setImmediate(() => procs[1].text("m2", "recuperado"));
	});
	assert.equal(procs.length, 2);
	assert.equal(procs[0].killed, true);
	assert.match(procs[1].written[0].message.content[0].text, /<tool_result id="toolu_1" name="read">/);
	assert.equal((e2.at(-1) as any).type, "done");
	assert.equal((e2.at(-1) as any).message.content[0].text, "recuperado");
	assert.deepEqual([infos[1].plan, infos[1].reason], ["restart", "missing-tool-call"]);
});

test("claude giving up after part of the answer reached Pi fails that request instead of hanging or duplicating it", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const e2 = await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1")], () => {
		procs[0].emit(MESSAGE_START);
		hosts[0].drop("toolu_1");
	});
	const last = e2.at(-1) as any;
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /claude stopped waiting for a tool result/);
	assert.equal(procs.length, 1, "no restart inside a request that already streamed");
	assert.equal(procs[0].killed, true);
});

test("a drop reported by a host that was already replaced changes nothing", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	hosts[0].drop("toolu_1");
	await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1")], () => procs[1].text("m2", "ok"));
	hosts[0].drop("toolu_1");
	assert.equal(procs[1].killed, false);
});

test("long Pi tools are not cut by claude's 5-minute MCP idle timer: per-server timeout and idle timer off", () => {
	assert.deepEqual(mcpConfig("http://127.0.0.1:9/t"), { mcpServers: { pi: { type: "http", url: "http://127.0.0.1:9/t", timeout: 86400000 } } });
	const env = buildChildEnv({ PATH: "/bin", CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "1000", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "1" }, { kind: "oauth", value: "sk-ant-oat01-s" }, "/c");
	assert.equal(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "0");
	assert.equal(env.MCP_TOOL_TIMEOUT, "86400000");
	assert.equal("CLAUDE_AUTO_BACKGROUND_TASKS" in env, false, "claude must not move a parked Pi tool call to the background");
	assert.equal("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS" in env, false);
	assert.equal(env.PATH, "/bin");
});

test("parallel tool calls answered together, then claude's result: claude is not stopped", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee dos")], () => {
		const ev = (event: any) => procs[0].emit({ type: "stream_event", event });
		ev({ type: "message_start", message: { id: "m1", usage: {} } });
		for (const [i, id] of [[0, "toolu_a"], [1, "toolu_b"]] as const) {
			ev({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: "mcp__pi__read", input: {} } });
			ev({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: id }) } });
			ev({ type: "content_block_stop", index: i });
		}
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" } });
		ev({ type: "message_stop" });
	});
	await turn(session, [u("lee dos"), (e1.at(-1) as any).message, readResult("toolu_a"), readResult("toolu_b")], () => procs[0].text("m2", "ok"));
	assert.deepEqual(hosts[0].resolved.map(([id]) => id), ["toolu_a", "toolu_b"]);
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	assert.equal(procs[0].killed, false);
	assert.equal(procs.length, 1);
});

test("an error result while Pi still runs the tool stops claude; the next request restarts with reason `missing-tool-call`", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("revisa")], () => procs[0].toolUse("m1", "toolu_long", "read", { path: "a" }));
	procs[0].emit({ type: "result", subtype: "error_during_execution", is_error: true });
	assert.equal(procs[0].killed, true);
	await turn(session, [u("revisa"), (e1.at(-1) as any).message, readResult("toolu_long")], () => procs[1].text("m2", "ok"));
	assert.deepEqual([infos[1].plan, infos[1].reason], ["restart", "missing-tool-call"]);
});

test("claude ending its turn while the results request waits (nothing streamed yet) restarts within that request", async () => {
	const { session, procs, hosts } = setup();
	const e1 = await turn(session, [u("lee")], () => procs[0].toolUse("m1", "toolu_1", "read", { path: "a" }));
	const e2 = await turn(session, [u("lee"), (e1.at(-1) as any).message, readResult("toolu_1")], () => {
		procs[0].emit({ type: "result", subtype: "success", is_error: false }); // claude never took the delivered result
		setImmediate(() => procs[1].text("m2", "recuperado"));
	});
	assert.equal(hosts[0].resolved.length, 1, "the result was handed over before claude ended its turn");
	assert.equal(procs[0].killed, true);
	assert.equal((e2.at(-1) as any).message.content[0].text, "recuperado");
});

test("after a drop the restart reason `missing-tool-call` is reported once; later turns on the new process have no reason", async () => {
	const infos: TurnInfo[] = [];
	const { session, procs, hosts } = setup({ onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("revisa")], () => procs[0].toolUse("m1", "toolu_long", "read", { path: "a" }));
	hosts[0].drop("toolu_long");
	const history = [u("revisa"), (e1.at(-1) as any).message, readResult("toolu_long")];
	const e2 = await turn(session, history, () => procs[1].text("m2", "ok"));
	procs[1].emit({ type: "result", subtype: "success", is_error: false });
	await turn(session, [...history, (e2.at(-1) as any).message, u("sigue")], () => procs[1].text("m3", "b"));
	assert.deepEqual(infos.map((i) => [i.plan, i.reason]), [["spawn", undefined], ["restart", "missing-tool-call"], ["send", undefined]]);
});

// --- latency timing (opt-in) ---
const sse = (p: FakeProc, event: any) => p.emit({ type: "stream_event", event });

test("timing on: one settled turn reports monotonic marks from start to settle, plus model, output tokens and stop reason, and no prompt text", async () => {
	let now = 100;
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ timing: () => true, clock: () => now, onTurn: (i) => infos.push(structuredClone(i)) });
	await turn(session, [u("SECRET prompt text")], () => {
		const p = procs[0];
		now = 130; p.emit({ type: "system", subtype: "init", session_id: UUID_X });
		now = 140; sse(p, { type: "message_start", message: { id: "m1", usage: { input_tokens: 1 } } });
		now = 150; sse(p, { type: "content_block_start", index: 0, content_block: { type: "thinking" } });
		now = 160; sse(p, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
		now = 170; sse(p, { type: "content_block_stop", index: 0 });
		sse(p, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
		now = 180; sse(p, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "a" } });
		now = 190; sse(p, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "b" } });
		sse(p, { type: "content_block_stop", index: 1 });
		sse(p, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
		now = 200; sse(p, { type: "message_stop" });
		now = 205;
	});
	assert.equal(infos.length, 1);
	const t = infos[0].timing!;
	assert.deepEqual(t, { model: "claude-sonnet-5-5", spawn: 0, firstLine: 30, messageStart: 40, firstThinking: 60, firstText: 80, stop: 100, settle: 105 });
	assert.equal(infos[0].stopReason, "stop");
	assert.equal(infos[0].usage?.output, 7);
	assert.equal(infos[0].plan, "spawn");
	const marks = [t.spawn, t.firstLine, t.messageStart, t.firstThinking, t.firstText, t.stop, t.settle] as number[];
	assert.deepEqual([...marks].sort((a, b) => a - b), marks, "marks never go backwards");
	assert.equal(JSON.stringify(infos[0]).includes("SECRET"), false);
});

test("timing on: a tool-call turn marks the first tool call and never a text mark; a rate-limit notice is not the first event", async () => {
	let now = 0;
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ timing: () => true, clock: () => now, onTurn: (i) => infos.push(structuredClone(i)) });
	await turn(session, [u("go")], () => {
		now = 10; procs[0].emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
		now = 20; procs[0].toolUse("m1", "t1", "read", { path: "/secret/path" });
		now = 25;
	});
	const t = infos[0].timing!;
	assert.equal(t.firstLine, 20);
	assert.equal(t.firstTool, 20);
	assert.equal(t.firstText, undefined);
	assert.equal(infos[0].stopReason, "toolUse");
	assert.equal(JSON.stringify(t).includes("secret"), false);
});

test("timing on: a restart reports its category and the spawn mark", async () => {
	let now = 0;
	const infos: TurnInfo[] = [];
	const { session, procs } = setup({ timing: () => true, clock: () => now, onTurn: (i) => infos.push(structuredClone(i)) });
	const e1 = await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	procs[0].emit({ type: "result", subtype: "success", is_error: false });
	await turn(session, [u("hola"), (e1.at(-1) as any).message, u("y?")], () => procs[1].text("m2", "b"), { model: "claude-opus-5-5" });
	assert.equal(infos[1].plan, "restart");
	assert.equal(infos[1].reason, "model");
	assert.equal(infos[1].timing?.model, "claude-opus-5-5");
	assert.equal(typeof infos[1].timing?.spawn, "number");
});

test("timing off (default): no mark is taken, the clock is never read and TurnInfo has no timing key", async () => {
	let clockCalls = 0;
	const infos: TurnInfo[] = [];
	for (const timing of [undefined, () => false]) {
		const { session, procs } = setup({ timing, clock: () => { clockCalls++; return 0; }, onTurn: (i) => infos.push(structuredClone(i)) });
		await turn(session, [u("hola")], () => procs[0].text("m1", "a"));
	}
	assert.equal(clockCalls, 0);
	assert.equal(infos.length, 2);
	for (const i of infos) assert.equal("timing" in i, false);
});

test("timing: a throwing timing switch or clock never breaks the turn", async () => {
	const infos: TurnInfo[] = [];
	const a = setup({ timing: () => { throw new Error("boom"); }, onTurn: (i) => infos.push(structuredClone(i)) });
	const events = await turn(a.session, [u("hola")], () => a.procs[0].text("m1", "a"));
	assert.equal(events.at(-1)?.type, "done");
	assert.equal("timing" in infos[0], false);
});
