// Spawns the official `claude` binary in stream-json mode.
import { spawn } from "node:child_process";
import { mkdirSync, chmodSync, mkdtempSync, writeFileSync, rmSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpConfig, buildClaudeArgs, claudeSystemPrompt, buildChildEnv, SESSION_ID_PATTERN, type ClaudeProc, type SpawnOptions } from "./session.ts";
import { createLineReader } from "./sync.ts";

const STDERR_KEEP = 8192;

/** Writes the system prompt and MCP config to a fresh 0700 directory with 0600 files; returns their paths and a cleanup. */
function writeLaunchFiles(opts: SpawnOptions) {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-relay-"));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	const systemPromptFile = join(dir, "system-prompt.txt");
	const mcpConfigFile = join(dir, "mcp.json");
	try {
		writeFileSync(systemPromptFile, claudeSystemPrompt(opts.systemPrompt, opts.toolNames), { mode: 0o600 });
		writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig(opts.mcpUrl)), { mode: 0o600 });
	} catch (e) { cleanup(); throw e; }
	return { systemPromptFile, mcpConfigFile, cleanup };
}

/**
 * Best-effort removal of claude's transcript files for these session ids: `<configDir>/projects/<project>/<id>.jsonl`.
 * Only UUID ids are used, only regular files directly inside real project directories are unlinked, and nothing reached through a
 * symlink is touched (the `projects` directory, a project directory or a transcript file), so it can never leave `configDir`.
 */
export function removeSessionTranscripts(configDir: string, sessionIds: string[]): void {
	const ids = sessionIds.filter((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id));
	if (!ids.length) return;
	try {
		const projects = join(configDir, "projects");
		if (!lstatSync(projects).isDirectory()) return;
		for (const entry of readdirSync(projects, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue; // a Dirent of a symlink is not a directory
			for (const id of ids) {
				const file = join(projects, entry.name, `${id}.jsonl`);
				try { if (lstatSync(file).isFile()) unlinkSync(file); } catch { /* missing or busy */ }
			}
		}
	} catch { /* no projects directory yet, or unreadable: nothing to remove */ }
}

/**
 * Removes session transcripts not touched for `maxAgeMs` (left behind by a Pi that crashed or was killed). Same confinement as
 * `removeSessionTranscripts`: only regular `<uuid>.jsonl` files directly under real `projects/<dir>/` directories; never throws.
 */
export function sweepStaleTranscripts(configDir: string, maxAgeMs: number, now = Date.now()): void {
	try {
		const projects = join(configDir, "projects");
		if (!lstatSync(projects).isDirectory()) return;
		for (const entry of readdirSync(projects, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const file of readdirSync(join(projects, entry.name), { withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".jsonl") || !SESSION_ID_PATTERN.test(file.name.slice(0, -".jsonl".length))) continue;
				const path = join(projects, entry.name, file.name);
				try { if (now - lstatSync(path).mtimeMs > maxAgeMs) unlinkSync(path); } catch { /* missing or busy */ }
			}
		}
	} catch { /* no projects directory yet, or unreadable */ }
}

export function spawnClaude(opts: SpawnOptions, bin = process.env.PI_CLAUDE_RELAY_CLAUDE_BIN || "claude", configDir: string): ClaudeProc {
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	chmodSync(configDir, 0o700); // an existing dir may be looser
	const files = writeLaunchFiles(opts);
	let child: ReturnType<typeof spawn>;
	try {
		const args = buildClaudeArgs({ model: opts.model, effort: opts.effort, toolNames: opts.toolNames, systemPromptFile: files.systemPromptFile, mcpConfigFile: files.mcpConfigFile, sessionId: opts.sessionId, resume: opts.resume });
		child = spawn(bin, args, { cwd: opts.cwd, env: buildChildEnv(process.env, opts.credential, configDir), stdio: ["pipe", "pipe", "pipe"] });
	} catch (e) { files.cleanup(); throw e; }
	let stderr = "";
	let lineCb: (v: any) => void = () => {};
	let exitCb: (code: number | null, stderr: string) => void = () => {};
	let exited = false;
	const finish = (code: number | null, extra = "") => {
		files.cleanup();
		if (exited) return;
		exited = true;
		try { exitCb(code, stderr + extra); } catch { /* a throwing consumer must not become an uncaught exception */ }
	};
	const gone = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
	const terminate = (hard = false) => {
		try { child.stdin.end(); } catch { /* already closed */ }
		if (hard) { child.kill("SIGKILL"); return; }
		child.kill("SIGTERM");
		setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000).unref();
	};
	/** A failure in a consumer or the reader: stop claude and report it through onExit so the session fails the turn. */
	let failed = false;
	const fatal = (what: string, e: unknown) => {
		if (failed || exited) return;
		failed = true;
		const text = e instanceof Error ? e.message : String(e);
		finish(null, `\n${what}: ${text}`);
		terminate();
	};
	child.stdout.setEncoding("utf8");
	const read = createLineReader(
		(v) => { try { lineCb(v); } catch (e) { fatal("claude output handler failed", e); } },
		undefined,
		(message) => fatal("claude output rejected", message),
	);
	child.stdout.on("data", (d: string) => { if (failed) return; try { read(d); } catch (e) { fatal("claude output reader failed", e); } });
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (d: string) => { stderr = (stderr + d).slice(-STDERR_KEEP); });
	child.stdin.on("error", () => {}); // EPIPE after exit is reported through `exit`
	child.on("error", (e) => finish(null, `\n${e.message}`));
	child.on("exit", (code) => finish(code));
	return {
		write(value) { if (!exited && child.stdin.writable) child.stdin.write(JSON.stringify(value) + "\n"); },
		onLine(cb) { lineCb = cb; },
		onExit(cb) { exitCb = cb; },
		gone,
		kill(hard) {
			if (exited) { if (hard && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); return; }
			exited = true; // a deliberate kill is not an unexpected exit
			files.cleanup(); // claude reads both files at startup
			terminate(hard);
		},
	};
}
