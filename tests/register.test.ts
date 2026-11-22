import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRelay, adoptProvider } from "../src/register.ts";
import { createHash } from "node:crypto";
import { readdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const piAi = {
	collapseSystemMessages: (c: any) => c,
	getCurrentSystemPrompt: () => "",
	getCurrentTools: () => [],
	createAssistantMessageEventStream: () => ({ push() {}, end() {} }),
};

function fakePi() {
	const registered: [string, any][] = [];
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	return {
		registered, handlers, commands,
		pi: {
			registerProvider: (name: string, config: any) => { registered.push([name, config]); },
			on: (event: string, h: Function) => { handlers[event] = h; },
			registerCommand: (name: string, options: any) => { commands[name] = options; },
		} as any,
	};
}

test("registers the built-in `anthropic` provider with streamSimple and no catalog/auth replacement", () => {
	const { pi, registered } = fakePi();
	const provider = registerRelay(pi, { piAi: piAi as any, env: {} });
	assert.ok(provider);
	assert.equal(registered.length, 1);
	const [name, config] = registered[0];
	assert.equal(name, "anthropic");
	assert.equal(typeof config.streamSimple, "function");
	assert.equal(config.api, "anthropic-messages");
	for (const key of ["models", "apiKey", "baseUrl", "oauth", "headers", "authHeader", "refreshModels", "name"]) {
		assert.equal(key in config, false, `config must not set ${key}`);
	}
});

test("closes the relay session when the Pi session shuts down", async () => {
	const { pi, handlers } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: {} });
	assert.equal(typeof handlers.session_shutdown, "function");
	await handlers.session_shutdown({}, { sessionManager: { getSessionId: () => "s1" } });
});

test("PI_CLAUDE_RELAY=off|0|false registers nothing, so Pi streams Anthropic directly", () => {
	for (const v of ["off", "0", "false", "OFF"]) {
		const { pi, registered, handlers } = fakePi();
		const provider = registerRelay(pi, { piAi: piAi as any, env: { PI_CLAUDE_RELAY: v } });
		assert.equal(provider, undefined, v);
		assert.equal(registered.length, 0, v);
		assert.deepEqual(Object.keys(handlers), [], v);
	}
});

test("other PI_CLAUDE_RELAY values keep the relay on", () => {
	const { pi, registered } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: { PI_CLAUDE_RELAY: "on" } });
	assert.equal(registered.length, 1);
});

test("registers an after_provider_response handler that shows Claude quota in the footer and warns when not allowed", () => {
	const { pi, handlers } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: {} });
	assert.equal(typeof handlers.after_provider_response, "function");
	const status: any[] = [], notes: any[] = [];
	const ctx = { ui: { setStatus: (...a: any[]) => status.push(a), notify: (...a: any[]) => notes.push(a) } };
	handlers.after_provider_response({ status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Date.now() / 1000 + 3600) } }, ctx);
	assert.equal(status[0][0], "claude-relay");
	assert.match(status[0][1], /^Claude limit reached · resets in /);
	assert.equal(notes[0][1], "error");
});

function loginCtx(auth: { configured: boolean; source?: string }, oauth: boolean, provider = "anthropic") {
	const status: any[] = [];
	const model = { provider, id: "claude-sonnet-5-5" };
	const ctx = {
		model,
		ui: { setStatus: (...a: any[]) => status.push(a) },
		modelRegistry: {
			getProviderAuthStatus: (p: string) => (p === "anthropic" ? auth : { configured: false }),
			isUsingOAuth: () => oauth,
			getAll: () => [{ provider: "anthropic", id: "claude-sonnet-5-5" }],
		},
	};
	return { ctx, status };
}

test("session_start shows the relay and the space's Anthropic login in the footer right away", async () => {
	const cases: [{ configured: boolean; source?: string }, boolean, string][] = [
		[{ configured: true, source: "stored" }, true, "✓ Claude relay · subscription"],
		[{ configured: true, source: "stored" }, false, "✓ Claude relay · API key"],
		[{ configured: false }, false, "✗ Claude relay · no Anthropic login in this space (/login)"],
	];
	for (const [auth, oauth, expected] of cases) {
		const { pi, handlers } = fakePi();
		registerRelay(pi, { piAi: piAi as any, env: {} });
		const { ctx, status } = loginCtx(auth, oauth);
		await handlers.session_start({ type: "session_start" }, ctx);
		assert.deepEqual(status, [["claude-relay", expected]]);
	}
});

test("the login status works when the current model is not Anthropic, and never breaks the session", async () => {
	const { pi, handlers } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: {} });
	const { ctx, status } = loginCtx({ configured: true, source: "stored" }, true, "openai");
	await handlers.session_start({ type: "session_start" }, ctx);
	assert.deepEqual(status, [["claude-relay", "✓ Claude relay · subscription"]]);
	await handlers.session_start({ type: "session_start" }, { ui: { setStatus() { throw new Error("no ui"); } } });
});

test("opted out: no login status", () => {
	const { pi, handlers } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: { PI_CLAUDE_RELAY: "off" } });
	assert.equal(handlers.session_start, undefined);
});

// --- /claude-relay notify (S6) ---
const STATE = (w: string, l: string) => `Claude relay notifications: warning ${w}, limit ${l}`;
const USAGE = "Usage: /claude-relay notify [warning|limit] [on|off] | stats";

function tmpSettings() {
	const dir = mkdtempSync(join(tmpdir(), "relay-settings-"));
	return { dir, file: join(dir, "agent", "claude-relay-settings.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
function setup(file: string) {
	const f = fakePi();
	registerRelay(f.pi, { piAi: piAi as any, env: {}, settingsFile: file });
	const notes: [string, string | undefined][] = [];
	const status: any[] = [];
	const ctx = { ui: { notify: (m: string, t?: string) => notes.push([m, t]), setStatus: (...a: any[]) => status.push(a) } };
	const run = (args: string) => f.commands["claude-relay"].handler(args, ctx);
	return { ...f, notes, status, ctx, run };
}
const rejected = () => ({ status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Date.now() / 1000 + 3600) } });
const warned = () => ({ status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed_warning", "anthropic-ratelimit-unified-representative-claim": "five_hour", "anthropic-ratelimit-unified-reset": String(Date.now() / 1000 + 3600) } });

test("registers the claude-relay command with a description and argument completions", async () => {
	const t = tmpSettings();
	try {
		const { commands } = setup(t.file);
		const cmd = commands["claude-relay"];
		assert.equal(typeof cmd.handler, "function");
		assert.equal(typeof cmd.description, "string");
		const labels = (items: any) => (items ?? []).map((i: any) => i.value);
		assert.deepEqual(labels(await cmd.getArgumentCompletions("")), ["notify", "stats"]);
		assert.deepEqual(labels(await cmd.getArgumentCompletions("st")), ["stats"]);
		assert.equal(await cmd.getArgumentCompletions("stats "), null);
		assert.deepEqual(labels(await cmd.getArgumentCompletions("notify ")), ["notify warning", "notify limit"]);
		assert.deepEqual(labels(await cmd.getArgumentCompletions("notify warning ")), ["notify warning on", "notify warning off"]);
		assert.equal(await cmd.getArgumentCompletions("bogus "), null);
	} finally { t.done(); }
});

test("opted out: no command", () => {
	const { pi, commands } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: { PI_CLAUDE_RELAY: "off" } });
	assert.deepEqual(Object.keys(commands), []);
});

test("/claude-relay notify shows the state (defaults on/on) as info and writes nothing", async () => {
	const t = tmpSettings();
	try {
		const { run, notes } = setup(t.file);
		await run("notify");
		assert.deepEqual(notes, [[STATE("on", "on"), "info"]]);
		assert.equal(existsSync(t.file), false);
	} finally { t.done(); }
});

test("setting warning or limit is independent, confirmed with the state line, and persisted as JSON with mode 0600", async () => {
	const t = tmpSettings();
	try {
		const { run, notes } = setup(t.file);
		await run("notify warning off");
		assert.deepEqual(notes.at(-1), [STATE("off", "on"), "info"]);
		assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), { notify: { warning: false, limit: true } });
		assert.equal(statSync(t.file).mode & 0o777, 0o600);
		await run("notify limit off");
		assert.deepEqual(notes.at(-1), [STATE("off", "off"), "info"]);
		await run("notify warning on");
		assert.deepEqual(notes.at(-1), [STATE("on", "off"), "info"]);
		assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), { notify: { warning: true, limit: false } });
		await run("  notify   limit   on  ");
		assert.deepEqual(notes.at(-1), [STATE("on", "on"), "info"]);
		await run("notify");
		assert.deepEqual(notes.at(-1), [STATE("on", "on"), "info"]);
	} finally { t.done(); }
});

test("invalid input warns with the usage text and leaves state and file unchanged", async () => {
	const t = tmpSettings();
	try {
		const { run, notes } = setup(t.file);
		await run("notify limit off");
		const before = readFileSync(t.file, "utf8");
		for (const bad of ["", "bogus", "notify bogus", "notify warning", "notify warning maybe", "notify warning on extra", "notify on", "notify limit off now"]) {
			notes.length = 0;
			await run(bad);
			assert.deepEqual(notes, [[USAGE, "warning"]], JSON.stringify(bad));
			assert.equal(readFileSync(t.file, "utf8"), before, JSON.stringify(bad));
		}
		notes.length = 0;
		await run("notify");
		assert.deepEqual(notes, [[STATE("on", "off"), "info"]]);
	} finally { t.done(); }
});

test("invalid input on a fresh space creates no settings file", async () => {
	const t = tmpSettings();
	try {
		const { run } = setup(t.file);
		await run("notify warning maybe");
		assert.equal(existsSync(t.file), false);
	} finally { t.done(); }
});

test("the switches control the pop-ups independently while the footer keeps updating", async () => {
	const t = tmpSettings();
	try {
		const { run, handlers, notes, status, ctx } = setup(t.file);
		await run("notify warning off");
		notes.length = 0;
		handlers.after_provider_response(warned(), ctx);
		assert.deepEqual(notes, []);
		assert.equal(status.length, 1);
		handlers.after_provider_response(rejected(), ctx);
		assert.equal(notes.length, 1);
		assert.equal(notes[0][1], "error");
		await run("notify warning on");
		await run("notify limit off");
		notes.length = 0;
		const before = status.length;
		handlers.after_provider_response(warned(), ctx);
		assert.equal(notes.length, 1);
		assert.equal(notes[0][1], "warning");
		handlers.after_provider_response(rejected(), ctx);
		assert.equal(notes.length, 1);
		assert.equal(status.length, before + 2);
		assert.match(status.at(-1)[1], /^Claude limit reached/);
	} finally { t.done(); }
});

test("settings survive a fresh registerRelay (reload from the file)", async () => {
	const t = tmpSettings();
	try {
		await setup(t.file).run("notify limit off");
		const second = setup(t.file);
		await second.run("notify");
		assert.deepEqual(second.notes, [[STATE("on", "off"), "info"]]);
		second.handlers.after_provider_response(rejected(), second.ctx);
		assert.equal(second.notes.length, 1);
		assert.equal(second.status.length, 1);
	} finally { t.done(); }
});

test("a corrupt, unreadable-shape or partial settings file falls back to defaults without throwing", async () => {
	const t = tmpSettings();
	try {
		setup(t.file); // ensure nothing is written on load
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(t.dir, "agent"), { recursive: true });
		const cases: [string, string][] = [
			["{not json", STATE("on", "on")],
			["null", STATE("on", "on")],
			["[]", STATE("on", "on")],
			['{"notify":"x"}', STATE("on", "on")],
			['{"notify":{"warning":"no","limit":false}}', STATE("on", "off")],
			['{"notify":{"warning":false}}', STATE("off", "on")],
		];
		for (const [content, expected] of cases) {
			writeFileSync(t.file, content);
			const { run, notes } = setup(t.file);
			await run("notify");
			assert.deepEqual(notes, [[expected, "info"]], content);
		}
		writeFileSync(t.file, "{not json");
		const { run, notes } = setup(t.file);
		await run("notify warning off");
		assert.deepEqual(JSON.parse(readFileSync(t.file, "utf8")), { notify: { warning: false, limit: true } });
		assert.deepEqual(notes.at(-1), [STATE("off", "on"), "info"]);
	} finally { t.done(); }
});

test("a settings file that cannot be written still updates the switch in memory and never throws", async () => {
	const t = tmpSettings();
	try {
		// parent "directory" is a regular file, so the write must fail
		writeFileSync(join(t.dir, "agent"), "x");
		const { run, notes } = setup(t.file);
		await run("notify warning off");
		assert.deepEqual(notes, [[STATE("off", "on"), "info"], ["Could not save the setting; it applies until Pi restarts.", "warning"]]);
	} finally { t.done(); }
});

test("login status with Pi's theme: ✓ (subscription, API key) stays uncolored, ✗ line is error; plain without a theme", async () => {
	const fake = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
	const cases: [{ configured: boolean }, boolean, any, string][] = [
		[{ configured: true }, true, fake, "✓ Claude relay · subscription"],
		[{ configured: true }, false, fake, "✓ Claude relay · API key"],
		[{ configured: false }, false, fake, "<error>✗ Claude relay · no Anthropic login in this space (/login)</error>"],
		[{ configured: true }, true, undefined, "✓ Claude relay · subscription"],
		[{ configured: true }, true, { fg() { throw new Error("boom"); } }, "✓ Claude relay · subscription"],
	];
	for (const [auth, oauth, theme, expected] of cases) {
		const { pi, handlers } = fakePi();
		registerRelay(pi, { piAi: piAi as any, env: {} });
		const { ctx, status } = loginCtx(auth, oauth);
		(ctx.ui as any).theme = theme;
		await handlers.session_start({ type: "session_start" }, ctx);
		assert.deepEqual(status, [["claude-relay", expected]]);
	}
});

// --- lifecycle (T11 / S8) ---
const flush = () => new Promise((r) => setTimeout(r, 0));
const req = { messages: [{ role: "user", content: "x", timestamp: 1 }] } as any;
const claudeModel = { id: "claude-sonnet-5-5", api: "anthropic-messages", provider: "anthropic" } as any;

test("session_start registers the Pi session id as persistent; any other id is throwaway; shutdown closes and forgets it", async () => {
	const closed: string[] = [];
	const { pi, handlers } = fakePi();
	const provider = registerRelay(pi, {
		piAi: piAi as any, env: {},
		newSession: (key) => ({ async stream(_r, emit) { emit({ type: "done", reason: "stop", message: {} as any }); }, async close() { closed.push(key); } }),
	})!;
	await handlers.session_start({ type: "session_start" }, { sessionManager: { getSessionId: () => "main" } });
	provider.streamSimple(claudeModel, req, { sessionId: "main" } as any);
	provider.streamSimple(claudeModel, req, { sessionId: "summary-xyz" } as any);
	await flush(); await flush();
	assert.equal(provider.sessionCount(), 1, "only the registered session survives");
	assert.deepEqual(closed, ["summary-xyz"]);
	await handlers.session_shutdown({}, { sessionManager: { getSessionId: () => "main" } });
	assert.deepEqual(closed, ["summary-xyz", "main"]);
	assert.equal(provider.sessionCount(), 0);
});

test("session_start without a session manager still works (login footer only)", async () => {
	const { pi, handlers } = fakePi();
	registerRelay(pi, { piAi: piAi as any, env: {} });
	await handlers.session_start({ type: "session_start" }, {});
});

test("adoptProvider: one process exit listener across reloads; the previous provider's sessions are closed; exit closes the current one", async () => {
	const calls: string[] = [];
	const mk = (name: string) => ({ closeAll: async () => { calls.push(name); } });
	let exitCb: (() => void) | undefined;
	const listeners: string[] = [];
	const proc = { once: (ev: string, cb: () => void) => { listeners.push(ev); exitCb = cb; } } as any;
	adoptProvider(mk("p1"), proc);
	adoptProvider(mk("p2"), proc);
	adoptProvider(undefined, proc); // reloaded with the relay switched off
	adoptProvider(mk("p3"), proc);
	await flush();
	assert.deepEqual(listeners, ["exit"], "registered once");
	assert.deepEqual(calls, ["p1", "p2"], "each previous provider closed when the factory runs again");
	exitCb!();
	await flush();
	assert.deepEqual(calls, ["p1", "p2", "p3"]);
});


// --- prompt-cache stats and debug log (T14 / S9) ---
const sha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

function statsRig(env: NodeJS.ProcessEnv = {}, prompt = "SECRET SYSTEM PROMPT") {
	const f = fakePi();
	const infos: any[] = [];
	const byKey: Record<string, any[]> = {};
	const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
	const ai = {
		collapseSystemMessages: (c: any) => c,
		getCurrentSystemPrompt: () => prompt,
		getCurrentTools: () => tools,
		createAssistantMessageEventStream: () => ({ push() {}, end() {} }),
	};
	const provider = registerRelay(f.pi, {
		piAi: ai as any, env,
		newSession: (key, onTurn) => ({ async stream(_r, emit) { emit({ type: "done", reason: "stop", message: {} as any }); onTurn((byKey[key] ?? infos).shift()); }, async close() {} }),
	})!;
	const notes: [string, string | undefined][] = [];
	const ctx = { ui: { notify: (m: string, t?: string) => notes.push([m, t]) } };
	const ask = (key: string, extra: any = {}) => provider.streamSimple(claudeModel, { messages: [{ role: "system", content: "s" }, { role: "user", content: "x", timestamp: 1 }, { role: "assistant", content: [], timestamp: 2 }] } as any, { sessionId: key, apiKey: "sk-ant-oat01-DEBUGSECRET", ...extra } as any);
	return { ...f, provider, infos, byKey, notes, ctx, ask, tools, stats: () => f.commands["claude-relay"].handler("stats", ctx) };
}
const U = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

test("/claude-relay stats: exact text without restarts, as an info notification", async () => {
	const r = statsRig();
	await r.handlers.session_start({ type: "session_start" }, { sessionManager: { getSessionId: () => "main" } });
	r.infos.push({ plan: "spawn", usage: U(10, 5, 0, 90), stopReason: "stop" }, { plan: "send", usage: U(10, 5, 80, 10), stopReason: "stop" });
	r.ask("main"); r.ask("main");
	r.ask("main", { maxTokens: 1 }); // cache warm request, answered locally
	await flush(); await flush();
	await r.stats();
	assert.deepEqual(r.notes, [["Claude relay stats: 2 turns · cache hit 40%\nprocess starts: 1 · restarts: 0\ncache warm requests answered locally: 1 · one-off requests: 0", "info"]]);
});

test("/claude-relay stats: restarts by reason, and throwaway-session turns counted as one-off requests", async () => {
	const r = statsRig();
	await r.handlers.session_start({ type: "session_start" }, { sessionManager: { getSessionId: () => "main" } });
	r.infos.push(
		{ plan: "spawn", usage: U(1, 0, 2, 0) },
		{ plan: "restart", reason: "abort", usage: U(1, 0, 2, 0) },
		{ plan: "restart", reason: "model" },
		{ plan: "restart", reason: "abort" },
	);
	r.byKey["summary-123"] = [{ plan: "spawn", usage: U(9, 9, 9, 9) }]; // throwaway session (compaction)
	for (let i = 0; i < 4; i++) r.ask("main");
	r.ask("summary-123");
	await flush(); await flush(); await flush();
	await r.stats();
	assert.equal(r.notes[0][0], "Claude relay stats: 4 turns · cache hit 67%\nprocess starts: 1 · restarts: 3 (abort 2, model 1)\ncache warm requests answered locally: 0 · one-off requests: 1");
	assert.equal(r.notes[0][1], "info");
});

test("/claude-relay stats with nothing recorded, with extra arguments, and with notify untouched", async () => {
	const r = statsRig();
	await r.stats();
	assert.equal(r.notes[0][0], "Claude relay stats: 0 turns · cache hit 0%\nprocess starts: 0 · restarts: 0\ncache warm requests answered locally: 0 · one-off requests: 0");
	await r.commands["claude-relay"].handler("stats now", r.ctx);
	assert.deepEqual(r.notes[1], [USAGE, "warning"]);
	await r.commands["claude-relay"].handler("notify", r.ctx);
	assert.equal(r.notes[2][0], STATE("on", "on"));
});

test("two providers keep separate stats", async () => {
	const a = statsRig(), b = statsRig();
	await a.handlers.session_start({}, { sessionManager: { getSessionId: () => "main" } });
	a.infos.push({ plan: "spawn" });
	a.ask("main");
	await flush(); await flush();
	await b.stats();
	assert.match(b.notes[0][0], /^Claude relay stats: 0 turns/);
});

test("PI_CLAUDE_RELAY_DEBUG_LOG: one JSON line per settled turn, mode 0600, hashes only, no prompt text, credential or session key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-debug-"));
	const file = join(dir, "debug.log");
	try {
		const r = statsRig({ PI_CLAUDE_RELAY_DEBUG_LOG: file });
		await r.handlers.session_start({ type: "session_start" }, { sessionManager: { getSessionId: () => "main" } });
		r.infos.push({ plan: "spawn", usage: U(10, 5, 0, 90), stopReason: "stop" }, { plan: "restart", reason: "abort", usage: U(1, 2, 3, 4), stopReason: "toolUse" });
		const before = Date.now();
		r.ask("main"); r.ask("main");
		await flush(); await flush();
		const text = readFileSync(file, "utf8");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 2);
		const toolsHash = sha8(JSON.stringify(r.tools.map((t) => [t.name, t.description, t.parameters])));
		for (const l of lines) {
			assert.equal(typeof l.t, "number");
			assert.ok(l.t >= before && l.t <= Date.now());
			delete l.t;
		}
		assert.deepEqual(Object.keys(lines[0]), ["session", "plan", "stopReason", "usage", "systemPromptHash", "toolsHash", "messages"]);
		assert.deepEqual(lines[0], { session: sha8("main"), plan: "spawn", stopReason: "stop", usage: U(10, 5, 0, 90), systemPromptHash: sha8("SECRET SYSTEM PROMPT"), toolsHash, messages: 2 });
		assert.deepEqual(lines[1], { session: sha8("main"), plan: "restart", reason: "abort", stopReason: "toolUse", usage: U(1, 2, 3, 4), systemPromptHash: sha8("SECRET SYSTEM PROMPT"), toolsHash, messages: 2 });
		for (const secret of ["sk-ant-oat01-DEBUGSECRET", "SECRET SYSTEM PROMPT", "\"main\"", "Read a file", "http://127.0.0.1"]) assert.equal(text.includes(secret), false, secret);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("debug log: off without the env var, and a write failure is swallowed (the turn and the stats still work)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-debug-"));
	try {
		const off = statsRig({});
		await off.handlers.session_start({}, { sessionManager: { getSessionId: () => "main" } });
		off.infos.push({ plan: "spawn" }); off.ask("main");
		await flush(); await flush();
		assert.deepEqual(readdirSync(dir), []);

		const bad = statsRig({ PI_CLAUDE_RELAY_DEBUG_LOG: join(dir, "missing-dir", "x.log") });
		await bad.handlers.session_start({}, { sessionManager: { getSessionId: () => "main" } });
		bad.infos.push({ plan: "spawn" }); bad.ask("main");
		await flush(); await flush();
		await bad.stats();
		assert.match(bad.notes[0][0], /^Claude relay stats: 1 turns/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the exit hook closes sessions synchronously (transcripts are removed before the process ends)", () => {
	let exit: (() => void) | undefined;
	const proc = { once: (_e: string, h: () => void) => { exit = h; } } as any;
	const calls: string[] = [];
	adoptProvider({ closeAll: async () => { calls.push("async"); }, closeAllNow: () => { calls.push("now"); } }, proc);
	exit!();
	assert.deepEqual(calls, ["now"]);
});
