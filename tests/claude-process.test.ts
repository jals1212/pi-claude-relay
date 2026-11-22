import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaude, removeSessionTranscripts, sweepStaleTranscripts } from "../src/claude-process.ts";

// Fake claude: reports its argv plus the content and mode of the files it was given, then waits for stdin to close.
const scratch: string[] = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

function fakeBin(): string {
	const dir = mkdtempSync(join(tmpdir(), "relay-fake-"));
	scratch.push(dir);
	const bin = join(dir, "claude");
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const file = (flag) => a[a.indexOf(flag) + 1];
const info = (f) => ({ path: f, content: fs.readFileSync(f, "utf8"), mode: fs.statSync(f).mode & 0o777, dirMode: fs.statSync(require("node:path").dirname(f)).mode & 0o777 });
const exitNow = a[a.indexOf("--model") + 1] === "exit-now";
const env = { configDir: process.env.CLAUDE_CONFIG_DIR, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, apiKey: process.env.ANTHROPIC_API_KEY };
process.stdout.write(JSON.stringify({ pid: process.pid, env, argv: a, sp: info(file("--system-prompt-file")), mcp: info(file("--mcp-config")) }) + "\\n", () => { if (exitNow) process.exit(0); });
if (!exitNow) process.stdin.resume();
`);
	chmodSync(bin, 0o755);
	return bin;
}

const opts = { credential: { kind: "oauth" as const, value: "sk-ant-oat01-space" }, model: "claude-haiku-5-5", systemPrompt: "SECRET-SYSTEM-PROMPT ".repeat(10000), effort: "low", mcpUrl: "http://127.0.0.1:9/secret-token", toolNames: ["read"], cwd: tmpdir() };

const within = <T>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), 5000).unref())]);

const spaceDir = mkdtempSync(join(tmpdir(), "relay-space-"));
scratch.push(spaceDir);
const configDir = join(spaceDir, "agent", "claude-relay");

function start(bin: string, model = opts.model) {
	const proc = spawnClaude({ ...opts, model }, bin, configDir);
	let stderr = "";
	const exited = new Promise<number | null>((resolve) => proc.onExit((code, s) => { stderr = s; resolve(code); }));
	const first = within(new Promise<any>((resolve) => proc.onLine(resolve)), "first line").catch((e) => { proc.kill(); throw new Error(`${e.message}; stderr: ${stderr}`); });
	return { proc, first, exited };
}

test("spawnClaude keeps the system prompt and MCP URL out of argv, in private files", async () => {
	const { proc, first } = start(fakeBin());
	const r = await first;
	const argv = r.argv.join(" ");
	assert.ok(!argv.includes("SECRET-SYSTEM-PROMPT"), "system prompt must not be visible in argv");
	assert.ok(!argv.includes("secret-token"), "MCP URL token must not be visible in argv");
	assert.equal(r.sp.content, opts.systemPrompt);
	assert.deepEqual(JSON.parse(r.mcp.content), { mcpServers: { pi: { type: "http", url: opts.mcpUrl, timeout: 86400000 } } });
	assert.equal(r.sp.mode, 0o600);
	assert.equal(r.mcp.mode, 0o600);
	assert.equal(r.sp.dirMode, 0o700);
	assert.deepEqual(r.env, { configDir, oauth: "sk-ant-oat01-space" }, "claude runs with the space's login and config dir only");
	assert.equal(statSync(configDir).mode & 0o777, 0o700, "the space's claude config dir is created private");
	proc.kill();
	assert.equal(existsSync(r.sp.path), false, "launch files are removed on kill");
});

test("spawnClaude removes its launch files when claude exits on its own", async () => {
	const { first, exited } = start(fakeBin(), "exit-now");
	const r = await first;
	assert.equal(await within(exited, "exit"), 0);
	assert.equal(existsSync(r.sp.path), false, "launch files are removed on exit");
});

test("spawnClaude reports a missing binary through onExit and leaves no launch files", async () => {
	const proc = spawnClaude(opts, join(tmpdir(), "no-such-claude-binary"), configDir);
	const stderr = await within(new Promise<string>((resolve) => proc.onExit((_c, s) => resolve(s))), "exit");
	assert.match(stderr, /ENOENT/);
});

function withTmpdir(fn: (tmp: string) => void) {
	const tmp = mkdtempSync(join(tmpdir(), "relay-tmp-"));
	const prev = process.env.TMPDIR;
	process.env.TMPDIR = tmp;
	try { fn(tmp); } finally {
		if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
		rmSync(tmp, { recursive: true, force: true });
	}
}

test("spawnClaude removes its launch dir when writing a launch file throws", () => withTmpdir((tmp) => {
	const badPrompt = { toString() { throw new Error("boom"); } } as any;
	assert.throws(() => spawnClaude({ ...opts, systemPrompt: badPrompt, cwd: tmp }, "true", configDir));
	assert.deepEqual(readdirSync(tmp), []);
}));

test("spawnClaude removes its launch dir when building the claude args throws", () => withTmpdir((tmp) => {
	assert.throws(() => spawnClaude({ ...opts, toolNames: undefined as any, cwd: tmp }, "true", configDir));
	assert.deepEqual(readdirSync(tmp), []);
}));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };

/** Collects uncaught errors for the duration of fn (node:test would otherwise fail the whole file). */
async function noUncaught(fn: () => Promise<void>) {
	const seen: unknown[] = [];
	const h = (e: unknown) => seen.push(e);
	process.on("uncaughtException", h);
	process.on("unhandledRejection", h);
	try { await fn(); await new Promise((r) => setTimeout(r, 50)); } finally { process.off("uncaughtException", h); process.off("unhandledRejection", h); }
	assert.deepEqual(seen, [], "no uncaught exception or rejection");
}

test("an exception in the line consumer kills claude and is reported through onExit with the error text", async () => {
	await noUncaught(async () => {
		const proc = spawnClaude(opts, fakeBin(), configDir);
		let stderr = "";
		let exits = 0;
		const exited = new Promise<number | null>((resolve) => proc.onExit((code, s) => { exits++; stderr = s; resolve(code); }));
		let pid = 0;
		let path = "";
		proc.onLine((v) => { pid = v.pid; path = v.sp.path; throw new Error("consumer blew up"); });
		await within(exited, "exit after consumer throw");
		assert.match(stderr, /consumer blew up/);
		assert.ok(pid > 0);
		assert.equal(await waitDead(pid), true, "the claude child is killed");
		assert.equal(existsSync(path), false, "launch files are removed");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(exits, 1, "onExit fires once");
	});
});

test("an exception in the exit consumer does not become an uncaught exception", async () => {
	await noUncaught(async () => {
		const { proc, first } = start(fakeBin(), "exit-now");
		proc.onExit(() => { throw new Error("exit consumer blew up"); });
		await first;
		await new Promise((r) => setTimeout(r, 300));
	});
});

test("a normal line consumer and onExit keep working after the guard is added", async () => {
	const { proc, first } = start(fakeBin());
	const r = await first;
	assert.equal(typeof r.pid, "number");
	proc.kill();
	assert.equal(await waitDead(r.pid), true);
});


// --- session id / resume flags and transcript cleanup (T15 / S9) ---
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("spawnClaude passes --session-id for a new relay session, --resume for a restart, and --no-session-persistence otherwise", async () => {
	const bin = fakeBin();
	const run = async (extra: object) => {
		const proc = spawnClaude({ ...opts, ...extra }, bin, configDir);
		const first = await within(new Promise<any>((resolve) => proc.onLine(resolve)), "first line");
		proc.kill();
		return first.argv as string[];
	};
	const fresh = await run({ sessionId: ID_A });
	assert.equal(fresh[fresh.indexOf("--session-id") + 1], ID_A);
	assert.ok(!fresh.includes("--no-session-persistence") && !fresh.includes("--resume"));
	const resumed = await run({ resume: ID_B });
	assert.equal(resumed[resumed.indexOf("--resume") + 1], ID_B);
	assert.ok(!resumed.includes("--no-session-persistence") && !resumed.includes("--session-id"));
	const throwaway = await run({});
	assert.ok(throwaway.includes("--no-session-persistence") && !throwaway.includes("--session-id") && !throwaway.includes("--resume"));
});

function transcriptDirs() {
	const config = mkdtempSync(join(tmpdir(), "relay-transcripts-"));
	scratch.push(config);
	const projects = join(config, "projects");
	mkdirSync(join(projects, "-work-a"), { recursive: true });
	mkdirSync(join(projects, "-work-b"), { recursive: true });
	return { config, projects };
}

test("removeSessionTranscripts deletes <id>.jsonl under projects/*/ and nothing else", () => {
	const { config, projects } = transcriptDirs();
	for (const f of [`-work-a/${ID_A}.jsonl`, `-work-b/${ID_A}.jsonl`, `-work-a/${ID_B}.jsonl`, `-work-a/other.jsonl`, `-work-a/${ID_A}.txt`]) writeFileSync(join(projects, f), "x");
	removeSessionTranscripts(config, [ID_A]);
	assert.deepEqual(readdirSync(join(projects, "-work-a")).sort(), [`${ID_B}.jsonl`, `${ID_A}.txt`, "other.jsonl"].sort());
	assert.deepEqual(readdirSync(join(projects, "-work-b")), []);
});

test("removeSessionTranscripts never follows symlinks (project dir, projects dir or transcript file) and never leaves the config dir", () => {
	const { config, projects } = transcriptDirs();
	const outside = mkdtempSync(join(tmpdir(), "relay-outside-"));
	scratch.push(outside);
	writeFileSync(join(outside, `${ID_A}.jsonl`), "precious");
	writeFileSync(join(outside, "target.jsonl"), "precious");
	symlinkSync(outside, join(projects, "-link-dir"));
	symlinkSync(join(outside, "target.jsonl"), join(projects, "-work-a", `${ID_A}.jsonl`));
	removeSessionTranscripts(config, [ID_A]);
	assert.equal(readFileSync(join(outside, `${ID_A}.jsonl`), "utf8"), "precious");
	assert.equal(readFileSync(join(outside, "target.jsonl"), "utf8"), "precious");
	assert.equal(existsSync(join(projects, "-work-a", `${ID_A}.jsonl`)), true, "a symlinked transcript is left alone");

	const config2 = mkdtempSync(join(tmpdir(), "relay-transcripts2-"));
	scratch.push(config2);
	symlinkSync(join(config, "projects"), join(config2, "projects"));
	writeFileSync(join(projects, "-work-b", `${ID_B}.jsonl`), "x");
	removeSessionTranscripts(config2, [ID_B]);
	assert.equal(existsSync(join(projects, "-work-b", `${ID_B}.jsonl`)), true, "a symlinked projects dir is not followed");
});

test("removeSessionTranscripts ignores ids that are not UUIDs (path traversal) and tolerates a missing projects dir", () => {
	const { config, projects } = transcriptDirs();
	writeFileSync(join(config, "secret.jsonl"), "x");
	writeFileSync(join(projects, "-work-a", "a.jsonl"), "x");
	removeSessionTranscripts(config, ["../../secret", "..", "", "a", "../secret"]);
	assert.equal(existsSync(join(config, "secret.jsonl")), true);
	assert.equal(existsSync(join(projects, "-work-a", "a.jsonl")), true);
	const empty = mkdtempSync(join(tmpdir(), "relay-empty-"));
	scratch.push(empty);
	assert.doesNotThrow(() => removeSessionTranscripts(empty, [ID_A]));
	assert.doesNotThrow(() => removeSessionTranscripts(join(empty, "missing"), [ID_A]));
});

test("sweepStaleTranscripts removes only old session transcripts inside projects/", () => {
	const configDir = mkdtempSync(join(tmpdir(), "relay-sweep-"));
	try {
		const project = join(configDir, "projects", "p1");
		mkdirSync(project, { recursive: true });
		const oldId = "11111111-1111-4111-8111-111111111111", freshId = "22222222-2222-4222-8222-222222222222";
		const now = Date.now();
		writeFileSync(join(project, `${oldId}.jsonl`), "old");
		utimesSync(join(project, `${oldId}.jsonl`), new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
		writeFileSync(join(project, `${freshId}.jsonl`), "fresh");
		writeFileSync(join(project, "notes.jsonl"), "not a session");
		utimesSync(join(project, "notes.jsonl"), new Date(now - 30 * 86400_000), new Date(now - 30 * 86400_000));
		sweepStaleTranscripts(configDir, 7 * 86400_000, now);
		assert.deepEqual(readdirSync(project).sort(), [`${freshId}.jsonl`, "notes.jsonl"]);
		sweepStaleTranscripts(join(configDir, "missing"), 1, now); // never throws
	} finally { rmSync(configDir, { recursive: true, force: true }); }
});

test("gone resolves when the child is really gone; a hard kill does not wait for a child that ignores SIGTERM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-fake-"));
	const bin = join(dir, "claude");
	writeFileSync(bin, `#!/usr/bin/env node
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ up: true }) + "\\n");
setInterval(() => {}, 1000);
`);
	chmodSync(bin, 0o755);
	try {
		const proc = spawnClaude(opts, bin, configDir);
		await within(new Promise<any>((resolve) => proc.onLine(resolve)), "first line");
		const t0 = Date.now();
		assert.ok(proc.gone instanceof Promise, "the process exposes when it is gone");
		proc.kill(true);
		await within(proc.gone, "gone");
		assert.ok(Date.now() - t0 < 1500, "SIGKILL: no 3 s grace period");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sweepStaleTranscripts never follows symlinks", () => {
	const ID_OLD = "33333333-3333-4333-8333-333333333333", ID_LINK = "44444444-4444-4444-8444-444444444444";
	const root = mkdtempSync(join(tmpdir(), "relay-sweep-sym-"));
	try {
		const outside = join(root, "outside"), cfg = join(root, "cfg");
		mkdirSync(outside); mkdirSync(join(cfg, "projects", "real"), { recursive: true });
		const old = new Date(Date.now() - 9 * 86400_000);
		writeFileSync(join(outside, `${ID_OLD}.jsonl`), "x"); utimesSync(join(outside, `${ID_OLD}.jsonl`), old, old);
		symlinkSync(outside, join(cfg, "projects", "linkdir"));
		writeFileSync(join(outside, "t.jsonl"), "t");
		symlinkSync(join(outside, "t.jsonl"), join(cfg, "projects", "real", `${ID_LINK}.jsonl`));
		sweepStaleTranscripts(cfg, 7 * 86400_000);
		assert.deepEqual(readdirSync(outside).sort(), [`${ID_OLD}.jsonl`, "t.jsonl"]);
		const cfg2 = join(root, "cfg2"); mkdirSync(cfg2); symlinkSync(outside, join(cfg2, "projects"));
		sweepStaleTranscripts(cfg2, 1);
		assert.deepEqual(readdirSync(outside).sort(), [`${ID_OLD}.jsonl`, "t.jsonl"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
