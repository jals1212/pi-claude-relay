// One relay session per Pi session: a live `claude` process + its MCP host.
// stream() turns one Pi request into exactly one Anthropic message from claude.
import { createHash, randomUUID } from "node:crypto";
import { createTurnMapper, claudeToolName, type RelayEvent, type TurnMapper, type Usage } from "./turn.ts";
import { planTurn, restartPlan, restartCategory, fingerprint, renderTranscript, type Plan, type PiMessage, type Snapshot, type SessionConfig, type PiContent } from "./sync.ts";
import type { McpHost, PiTool } from "./mcp-host.ts";
import { retryableRateLimitMessage } from "./rate-limit.ts";

export const TOOL_PREFIX = "mcp__pi__";

export type ClaudeCredential = { kind: "oauth" | "apiKey"; value: string };

export const NO_LOGIN_MESSAGE = "pi-claude-relay: this Pi space has no Anthropic login. Run /login and choose Anthropic in this space.";

/** The Pi space's resolved Anthropic credential: an OAuth token (subscription login) or an API key. */
export function claudeCredential(apiKey: string | undefined): ClaudeCredential {
	const value = apiKey?.trim();
	if (!value) throw new Error(NO_LOGIN_MESSAGE);
	return { kind: value.includes("sk-ant-oat") ? "oauth" : "apiKey", value };
}

/** A claude session id is a UUID; anything else read from claude's output is never used (it becomes a file name and a `--resume` argument). */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long a `stream()` waits for claude's `result` of an interrupted turn before the process is killed. */
export const INTERRUPT_TIMEOUT_MS = 5000;
/** Head start a user line gets over the tool results it arrives with, so claude has read it when the tool call returns. */
export const STEER_LEAD_MS = 100;
/** Anything that looks like an Anthropic key or a loopback MCP URL token, whoever it belongs to. */
const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const MCP_TOKEN_PATTERN = /(127\.0\.0\.1:\d+\/)[0-9a-f]{32}/g;

export interface SpawnOptions {
	credential: ClaudeCredential; model: string; systemPrompt: string; effort: string; mcpUrl: string; toolNames: string[]; cwd: string;
	/** Start a NEW claude session with this id (`--session-id`, persistence on). */
	sessionId?: string;
	/** Continue the claude session with this id (`--resume`) in a new process. With neither field the process is a throwaway (`--no-session-persistence`). */
	resume?: string;
}

export interface ClaudeProc {
	write(value: unknown): void;
	onLine(cb: (value: any) => void): void;
	onExit(cb: (code: number | null, stderr: string) => void): void;
	/** Stops claude. `hard` kills it at once (no chance to flush files); the default lets it exit by itself first. */
	kill(hard?: boolean): void;
	/** Resolves when the process is really gone (absent in test doubles). */
	gone?: Promise<void>;
}

export interface StreamRequest {
	model: string; systemPrompt: string; tools: PiTool[]; effort: string; cwd: string;
	messages: PiMessage[];
	/** The Pi space's resolved Anthropic credential (`options.apiKey`). */
	apiKey?: string;
	signal?: AbortSignal;
	/** A one-off request (compaction, summaries): no claude session is persisted, resumed or kept on disk. */
	throwaway?: boolean;
	/** Called with claude's `rate_limit_info`. claude usually emits it right after `message_stop`, so the most recent request keeps receiving it between turns. */
	/** Prices the assistant message's usage (fills `usage.cost`). */
	cost?: (usage: Usage) => void;
	onRateLimit?: (info: any) => void;
}

/** What one settled `stream()` call cost in process terms (for stats and the debug log). */
export interface TurnInfo {
	/** `spawn`: the session's first process; `restart`: a live or lost process was replaced (see `reason`); `send` / `resolve`: the live process was reused. */
	plan: "send" | "resolve" | "restart" | "spawn";
	/** Why a restart happened: `model`, `system-prompt`, `tools`, `effort`, `credential`, `history`, `missing-tool-call`, `other` (planner), or `abort`, `error`, `exit` (the previous process was lost). */
	reason?: string;
	/** A restart continued claude's own session (`--resume`) instead of replaying a flattened transcript; the cache and structured history survive. */
	resumed: boolean;
	/** Usage of the turn's final assistant message. */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	stopReason?: string;
}

export interface SessionDeps {
	spawn: (opts: SpawnOptions) => ClaudeProc;
	createHost: (tools: PiTool[]) => McpHost;
	api: string; provider: string;
	now?: () => number;
	onRateLimit?: (info: any) => void;
	/** Called once per `stream()` that reached a plan, when its turn settles. Observer errors are ignored. */
	onTurn?: (info: TurnInfo) => void;
	/** Starts a one-shot timer and returns its canceller; defaults to an unref'd `setTimeout`. Tests inject a manual one for the interrupt timeout. */
	setTimer?: (callback: () => void, ms: number) => () => void;
	/** Best-effort removal of the transcript files of these claude session ids (see `removeSessionTranscripts`). Called when the session closes and when a flattened replay replaces a session. */
	removeTranscripts?: (sessionIds: string[]) => void;
}

export interface RelaySession {
	stream(req: StreamRequest, emit: (e: RelayEvent) => void): Promise<void>;
	close(): Promise<void>;
	/** Synchronous close for process exit: ends the active turn, kills claude and removes the transcripts before returning. */
	closeNow(): void;
}

/** Launch inputs for claude. The system prompt and MCP config (which holds the secret MCP URL) travel in private files, never argv: argv is visible to every local user through `ps`, and Linux caps one argument at 128 KiB. */
export interface ClaudeArgsOptions { model: string; effort: string; toolNames: string[]; systemPromptFile: string; mcpConfigFile: string; sessionId?: string; resume?: string }

/** How long claude waits for one Pi tool call, in ms (24 h): Pi tools (reviews, CI, subagents) can run for a long time without output. */
export const TOOL_CALL_TIMEOUT_MS = 86_400_000;

/**
 * The per-server `timeout` is the wall-clock limit of one call and also the floor of claude's MCP idle timer, which otherwise
 * aborts an HTTP tool call that sends no response or progress for 5 minutes, while Pi is still running the tool.
 */
export function mcpConfig(mcpUrl: string): object {
	return { mcpServers: { pi: { type: "http", url: mcpUrl, timeout: TOOL_CALL_TIMEOUT_MS } } };
}

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
	// Session persistence stays on for relay sessions so a lost process can be continued with `--resume`; one-off requests keep it off.
	const persistence = o.resume ? ["--resume", o.resume] : o.sessionId ? ["--session-id", o.sessionId] : ["--no-session-persistence"];
	const args = [
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages", "--verbose",
		"--tools", "", "--strict-mcp-config", "--mcp-config", o.mcpConfigFile,
		"--setting-sources", "", "--permission-mode", "default", "--allowedTools", o.toolNames.map((n) => TOOL_PREFIX + claudeToolName(n)).join(","),
		...persistence, "--model", o.model, "--system-prompt-file", o.systemPromptFile,
		// claude asks the API for `display: "omitted"` by default, which streams thinking blocks with a signature and no text.
		"--thinking-display", "summarized",
	];
	if (o.effort && o.effort !== "off") args.push("--effort", o.effort);
	return args;
}

/** Child env: inherit the user's env, drop every inherited Claude/Anthropic credential and config dir, then give claude only the Pi space's credential and its own config dir, plus isolation guards. */
export function buildChildEnv(parent: NodeJS.ProcessEnv, credential: ClaudeCredential, configDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(parent)) {
		// Every ANTHROPIC_* (base URL, custom headers, Foundry keys, ...) could reroute or replace the space's credential.
		if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("ANTHROPIC_") || k === "CLAUDE_CONFIG_DIR") continue;
		// Auto-backgrounding would let claude go on while a Pi tool call is still parked.
		if (k === "CLAUDE_AUTO_BACKGROUND_TASKS") continue;
		env[k] = v;
	}
	env.CLAUDE_CONFIG_DIR = configDir;
	env[credential.kind === "oauth" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = credential.value;
	Object.assign(env, {
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTO_COMPACT: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "16384",
		MCP_TOOL_TIMEOUT: String(TOOL_CALL_TIMEOUT_MS),
		// 0 turns off the 5-minute idle timer for MCP tool calls (the per-server `timeout` in mcpConfig also lifts it).
		CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
	});
	return env;
}

export function toClaudeUserContent(content: string | PiContent[]): object[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.flatMap((c) =>
		c.type === "text" ? [{ type: "text", text: c.text }]
			: c.type === "image" ? [{ type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } }]
				: []);
}

const userLine = (content: object[]) => ({ type: "user", message: { role: "user", content } });
const CONTINUE = "Continue from where the conversation above left off.";

export const CLAUDE_MISSING_MESSAGE = 'pi-claude-relay: the "claude" CLI was not found. Install Claude Code or set PI_CLAUDE_RELAY=off to use Pi\'s direct Anthropic provider.';
export const OLD_CLAUDE_HINT = " pi-claude-relay needs Claude Code 2.1.330 or later.";

const defaultTimer = (callback: () => void, ms: number) => {
	const t = setTimeout(callback, ms);
	t.unref?.();
	return () => clearTimeout(t);
};

export function createSession(deps: SessionDeps): RelaySession {
	let proc: ClaudeProc | undefined;
	let host: McpHost | undefined;
	/** What claude's session knows. Kept when the process is lost, so a restart can resume the session; cleared only when a flattened replay starts a new one. */
	let snapshot: Snapshot | undefined;
	/** `recover`: restart claude for this same request; set while the request only waits for parked tool calls to be answered. */
	let active: { mapper: TurnMapper; settle: () => void; onRateLimit?: (info: any) => void; recover?: () => void } | undefined;
	let lastOnRateLimit: ((info: any) => void) | undefined;
	let lastRateStatus: string | undefined;
	let generation = 0;
	/** A claude process was started at some point (a later start is a restart, not a spawn). */
	let everSpawned = false;
	/** Why the previous process was lost outside the planner's decision (`abort`, `error`, `exit`); reported by the next turn. */
	let lost: string | undefined;
	const markLost = (reason: string) => { if (everSpawned && lost === undefined) lost = reason; };
	/** User lines written to claude whose `result` line has not arrived yet; claude answers each with one `result`. */
	let owed = 0;
	/** claude's current session id (it can change when a session is resumed); undefined for throwaway processes. */
	let sessionId: string | undefined;
	/** Every session id this relay session created or saw claude report: their transcripts are removed on close. */
	const sessionIds = new Set<string>();
	/** The current process has sent at least one line (it is up and reading stdin). */
	let procSeen = false;
	/** A resumed process that has not shown any sign of life yet: if it dies first, the request falls back to the flattened replay. */
	let trial: { gen: number; seen: boolean; fallback: () => void } | undefined;
	/** claude was interrupted and its `result` for the interrupted turn has not arrived: the next stream() waits for `promise`. */
	let draining: { promise: Promise<void>; end: () => void; cancel: () => void } | undefined;
	let closeCount = 0;
	/**
	 * A user line written into a running turn (it arrived with tool results). claude acknowledges every line it takes with a replay
	 * (`--replay-user-messages`): acknowledged before the turn's `result`, it was folded into that turn; otherwise it is still queued
	 * and claude will answer it as a turn of its own.
	 */
	const steers = new Set<string>();
	/** Turns claude still runs on its own for steering lines it did not fold: nobody asked for them, their events are dropped up to their `result`. */
	let discards = 0;

	const send = (p: ClaudeProc, content: object[]) => { owed++; p.write(userLine(content)); };

	const forget = (ids: string[]) => {
		if (!ids.length) return;
		try { deps.removeTranscripts?.(ids); } catch { /* best effort: a transcript that stays is only disk */ }
	};

	function endDrain() {
		const d = draining;
		draining = undefined;
		d?.cancel();
		d?.end();
	}

	/** Processes that were asked to stop and have not exited yet. */
	const dying = new Set<ClaudeProc>();
	/** How long close() waits for a killed claude to be gone before removing its transcripts. */
	const GONE_TIMEOUT_MS = 1500;

	async function teardown(reason = "Claude relay session restarted", hard = false) {
		owed = 0;
		steers.clear();
		discards = 0;
		trial = undefined;
		endDrain();
		const p = proc, h = host;
		proc = undefined; host = undefined; generation++;
		if (p) {
			p.kill(hard);
			// A soft-killed claude can take a moment to exit (and flush files): remember it so a process exit can still kill it hard.
			if (!hard && p.gone) { dying.add(p); void p.gone.then(() => dying.delete(p)).catch(() => {}); }
		}
		if (h) { h.failAll(reason); await h.close(); }
	}

	/** Waits for claude's `result` of the interrupted turn; after INTERRUPT_TIMEOUT_MS the process is killed instead (the next turn restarts, reason `abort`). */
	function beginDrain() {
		if (draining) return;
		let end!: () => void;
		const promise = new Promise<void>((r) => { end = r; });
		const cancel = (deps.setTimer ?? defaultTimer)(() => {
			if (draining?.promise !== promise) return;
			markLost("abort");
			void teardown("Request was aborted");
		}, INTERRUPT_TIMEOUT_MS);
		draining = { promise, end, cancel };
	}

	/**
	 * Pi gave up on the turn: ask claude to stop generating instead of killing it (the process, its cache and its history survive),
	 * answer parked MCP calls with an aborted error, and remember that claude has seen `messages` (but not the aborted answer).
	 */
	function interrupt(config: SessionConfig, messages: PiMessage[]) {
		const p = proc;
		if (!p) return;
		try { p.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }); } catch { /* an exit is reported through onExit */ }
		host?.failAll("Request was aborted");
		snapshot = { config, fingerprints: messages.map(fingerprint), pendingToolCallIds: [] };
		if (owed > 0) beginDrain();
	}

	/**
	 * claude went on without a tool result Pi still owes it: it gave up on a parked call (its MCP client timed out or cancelled), or
	 * it ended the turn. Its session no longer matches Pi's history, so it can never take that result: stop it now (no turn runs
	 * on its own meanwhile) and let the result restart claude with a replay. A request already waiting on the call restarts at
	 * once when nothing of it reached Pi yet; otherwise it fails instead of hanging.
	 */
	function abandonToolCalls(gen: number) {
		if (gen !== generation) return;
		markLost("missing-tool-call");
		const waiting = active && !active.mapper.finished ? active : undefined;
		void teardown("claude stopped waiting for this tool call");
		if (!waiting) return;
		if (waiting.recover && !waiting.mapper.started) { lost = undefined; waiting.recover(); return; }
		waiting.mapper.fail("claude stopped waiting for a tool result (its MCP client gave up on the call); send the message again to continue");
		waiting.settle();
	}

	/** Resumed process died (or answered with an error result) before it showed any sign of life: continue the request with the flattened replay. */
	function failResume(gen: number): boolean {
		const t = trial;
		if (!t || t.gen !== gen || t.seen || !active || active.mapper.finished) return false;
		trial = undefined;
		void teardown("Claude relay resume failed"); // synchronously detaches the dead process: its exit and later lines are ignored
		t.fallback();
		return true;
	}

	function onLine(gen: number, v: any) {
		if (gen !== generation) return;
		procSeen = true;
		// A replayed user line is only claude echoing its input, not a sign that the resumed session loaded.
		if (v?.type !== "result" && v?.type !== "user" && trial && trial.gen === gen) trial.seen = true;
		if (v?.type === "system" && v.subtype === "init") {
			// A resumed process may report a new session id; the next resume must use the current one.
			if (sessionId !== undefined && typeof v.session_id === "string" && SESSION_ID_PATTERN.test(v.session_id)) { sessionId = v.session_id; sessionIds.add(v.session_id); }
			return;
		}
		if (v?.type === "rate_limit_event") {
			const info = v.rate_limit_info;
			lastRateStatus = info?.status;
			deps.onRateLimit?.(info);
			(active?.onRateLimit ?? lastOnRateLimit)?.(info);
			return;
		}
		if (v?.type === "user") {
			if (v.isReplay === true && typeof v.uuid === "string") steers.delete(v.uuid); // folded into the running turn
			return;
		}
		if (v?.type === "result") {
			owed = Math.max(0, owed - 1);
			if (discards > 0) {
				// End of a turn claude ran for a queued steering line: nobody waits for it.
				discards--;
				if (draining && owed === 0) endDrain();
				return;
			}
			/** Requests still waiting for claude after this result. */
			const requestsLeft = owed;
			if (steers.size) {
				// The turn ended and claude never took these steering lines: it answers each next, as a turn of its own.
				discards += steers.size;
				owed += steers.size;
				steers.clear();
			}
			if (draining && owed === 0) endDrain();
			if (v.is_error && failResume(gen)) return;
			if (trial && trial.gen === gen) trial.seen = true;
			if (!active || active.mapper.finished) {
				// claude ended the turn while Pi still runs tools it asked for: it went on without their results.
				if (requestsLeft === 0 && snapshot?.pendingToolCallIds.length && host?.pendingIds().some((id) => snapshot!.pendingToolCallIds.includes(id))) abandonToolCalls(gen);
				return;
			}
			if (v.is_error) {
				const text = redact(typeof v.result === "string" && v.result ? v.result : `claude returned ${v.subtype ?? "an error"}`);
				active.mapper.fail(retryableRateLimitMessage(text, v, lastRateStatus));
				active.settle();
			} else if (requestsLeft === 0) {
				// claude finished everything it was asked and the turn never completed: nothing more will arrive.
				active.mapper.fail("claude ended the turn without a response");
				active.settle();
			}
			return;
		}
		if (v?.type !== "stream_event") return;
		if (discards > 0) return;
		if (owed === 0) {
			// claude is running a turn nobody is waiting for (a queued message it answered on its own): its events belong to no request,
			// and the next request must wait until that turn's `result`.
			beginDrain();
			return;
		}
		if (active && active.mapper.handle(v.event) === "done") active.settle();
	}

	let currentSecret = "";
	/** Text from claude (stderr, error results) may echo the credential; never surface it to Pi. */
	let currentMcpUrl = "";
	const redact = (text: string) => {
		for (const secret of [currentSecret, currentMcpUrl]) if (secret) text = text.split(secret).join("[redacted]");
		return text.replace(KEY_PATTERN, "[redacted]").replace(MCP_TOKEN_PATTERN, "$1[redacted]");
	};

	function onExit(gen: number, code: number | null, stderr: string) {
		if (gen !== generation) return;
		if (failResume(gen)) return;
		markLost("exit");
		let tail = stderr.trim().split("\n").slice(-5).join("\n");
		tail = redact(tail);
		void teardown();
		if (active && !active.mapper.finished) {
			// Preflight: turn the two classic setup failures into an actionable message.
			const missing = code === null && /spawn\b.*\bENOENT\b/.test(stderr);
			const oldClaude = !missing && /unknown option|unrecognized option/i.test(stderr);
			active.mapper.fail(missing ? CLAUDE_MISSING_MESSAGE : `claude exited with code ${code}${tail ? `: ${tail}` : ""}${oldClaude ? OLD_CLAUDE_HINT : ""}`);
			active.settle();
		}
	}

	/**
	 * Starts a fresh host + claude: a new claude session (`--session-id`, or none for a throwaway request), or, with `resume`, the
	 * continuation of an existing one. Returns false when the request was aborted or the session closed meanwhile (nothing is left running then).
	 */
	async function spawnFresh(req: StreamRequest, credential: ClaudeCredential, resume?: string): Promise<boolean> {
		await teardown();
		if (req.signal?.aborted) return false;
		const gen = generation;
		const h = deps.createHost(req.tools);
		host = h; // tracked from creation, so a failure or abort below can close it
		h.onDrop(() => abandonToolCalls(gen));
		// Aborts and close() bump `generation` and have already torn this host down; otherwise tear it down here.
		const release = () => (gen === generation ? teardown() : h.close().catch(() => {}));
		try { await h.start(); } catch (e) { await release(); throw e; }
		if (gen !== generation || req.signal?.aborted) { await release(); return false; } // the listener may have bound after close()
		currentSecret = credential.value;
		currentMcpUrl = h.url;
		const newId = resume || req.throwaway ? undefined : randomUUID();
		let p: ClaudeProc;
		try {
			p = deps.spawn({ credential, model: req.model, systemPrompt: req.systemPrompt, effort: req.effort, mcpUrl: h.url, toolNames: req.tools.map((t) => t.name), cwd: req.cwd, sessionId: newId, resume });
		} catch (e) { await release(); throw e; }
		if (!resume) {
			// A new claude session replaces the old one: nothing is known about it yet and the old transcript is obsolete.
			const old = [...sessionIds];
			sessionIds.clear();
			snapshot = undefined;
			sessionId = newId;
			if (newId) sessionIds.add(newId);
			forget(old);
		}
		procSeen = false;
		p.onLine((v) => onLine(gen, v));
		p.onExit((code, stderr) => onExit(gen, code, stderr));
		proc = p;
		everSpawned = true;
		return true;
	}

	const whenAborted = (signal: AbortSignal | undefined) => {
		let dispose = () => {};
		const promise = new Promise<void>((resolve) => {
			if (!signal) return;
			signal.addEventListener("abort", resolve as () => void, { once: true });
			dispose = () => signal.removeEventListener("abort", resolve as () => void);
		});
		return { promise, dispose };
	};

	async function stream(req: StreamRequest, emit: (e: RelayEvent) => void) {
		const mapper = createTurnMapper({ api: deps.api, provider: deps.provider, model: req.model, toolPrefix: TOOL_PREFIX, toolNames: req.tools.map((t) => t.name), now: deps.now, applyCost: req.cost, emit: (e) => {
			if (e.type === "toolcall_end") host?.expect(e.toolCall);
			emit(e);
		} });
		if (req.signal?.aborted) {
			// Pi aborted a tool phase: claude may be waiting on the parked calls Pi just answered with `Operation aborted`.
			if (proc && snapshot?.pendingToolCallIds.length && !draining) {
				const plan = planTurn(snapshot, { config: snapshot.config, messages: req.messages });
				if (plan.kind === "resolve" && !plan.then) {
					// With a steering line still queued in claude an interrupt would leave it there: kill instead.
					if (steers.size) { markLost("abort"); void teardown("Request was aborted"); }
					else interrupt(snapshot.config, req.messages);
				}
			}
			mapper.fail("Request was aborted", "aborted");
			return;
		}
		if (active && !active.mapper.finished) { active.mapper.fail("Superseded by a newer request"); active.settle(); }

		let credential: ClaudeCredential;
		try { credential = claudeCredential(req.apiKey); } catch (e) { mapper.fail((e as Error).message); return; }

		if (draining) {
			// The previous turn was interrupted: its `result` must arrive before claude can take the next message.
			const closedAt = closeCount;
			const aborted = whenAborted(req.signal);
			await Promise.race([draining.promise, aborted.promise]);
			aborted.dispose();
			if (req.signal?.aborted) { mapper.fail("Request was aborted", "aborted"); return; }
			if (closeCount !== closedAt) { mapper.fail("Claude relay session closed", "aborted"); return; }
		}

		const config: SessionConfig = { model: req.model, systemPrompt: req.systemPrompt, toolsKey: JSON.stringify(req.tools.map((t) => [t.name, t.description, t.parameters])), effort: req.effort, credentialKey: createHash("sha256").update(credential.value).digest("hex") };
		let plan: Plan = planTurn(snapshot, { config, messages: req.messages });
		let missingToolCall = false;
		if (!proc) {
			// The process was lost; the snapshot still describes claude's session. A plain continuation resumes it, a pending tool call cannot be resumed.
			if (plan.kind === "send") plan = restartPlan(req.messages, "process lost", plan.message);
			else if (plan.kind === "resolve") plan = planTurn(undefined, { config, messages: req.messages });
		} else if (plan.kind === "resolve") {
			// The parked call can be gone (claude's MCP client dropped, host reset): waiting for it would hang forever.
			const pending = new Set(host?.pendingIds() ?? []);
			if (!plan.results.every((r) => pending.has(r.toolCallId))) { plan = planTurn(undefined, { config, messages: req.messages }); missingToolCall = true; }
		}
		const resumeId = plan.kind === "restart" && plan.resume && sessionId && !req.throwaway ? sessionId : undefined;
		const info: TurnInfo = { plan: plan.kind, resumed: !!resumeId };
		if (plan.kind === "restart") {
			if (!proc && !everSpawned) info.plan = "spawn";
			else info.reason = missingToolCall ? "missing-tool-call" : proc ? restartCategory(plan.reason) : (lost ?? restartCategory(plan.reason));
		}
		lost = undefined;

		let settle!: () => void;
		const finished = new Promise<void>((r) => { settle = r; });
		const current: NonNullable<typeof active> = { mapper, settle, onRateLimit: req.onRateLimit };
		active = current;
		lastOnRateLimit = req.onRateLimit;
		/** The turn was handed to claude (a user line written or tool results delivered): an abort has something to interrupt. */
		let handedOff = false;
		const onAbort = () => {
			if (mapper.finished) return;
			mapper.fail("Request was aborted", "aborted");
			settle();
			trial = undefined;
			// With a steering line still unacknowledged an interrupt would leave it queued in claude: kill instead (the next turn restarts).
			if (proc && handedOff && procSeen && steers.size === 0) interrupt(config, req.messages);
			else { markLost("abort"); void teardown("Request was aborted"); }
		};
		req.signal?.addEventListener("abort", onAbort, { once: true });

		const failStart = () => { mapper.fail(req.signal?.aborted ? "Request was aborted" : "Claude relay session closed", "aborted"); settle(); };
		const startFlattened = async (p: Extract<Plan, { kind: "restart" }>) => {
			if (!(await spawnFresh(req, credential))) { failStart(); return; }
			const replay = p.replay.length ? [{ type: "text", text: renderTranscript(p.replay) }] : [];
			const input = p.input.kind === "user" ? toClaudeUserContent(p.input.message.content) : [{ type: "text", text: CONTINUE }];
			send(proc!, [...replay, ...input]);
			handedOff = true;
		};

		try {
			if (plan.kind === "restart") {
				const restartingPlan = plan;
				if (resumeId) {
					if (await spawnFresh(req, credential, resumeId)) {
						trial = { gen: generation, seen: false, fallback: () => {
							info.resumed = false;
							startFlattened(restartingPlan).catch((e) => { mapper.fail(`Claude relay failed to start: ${(e as Error).message}`); settle(); });
						} };
						send(proc!, toClaudeUserContent(restartingPlan.resume!.content));
						handedOff = true;
					} else failStart();
				} else await startFlattened(restartingPlan);
			} else if (plan.kind === "send") {
				send(proc!, toClaudeUserContent(plan.message.content));
				handedOff = true;
			} else {
				const results = plan.results;
				// If claude gives up on these calls before answering, restart for this same request instead of waiting for a turn that never comes.
				current.recover = () => {
					current.recover = undefined;
					info.plan = "restart"; info.reason = "missing-tool-call"; info.resumed = false;
					const p = planTurn(undefined, { config, messages: req.messages });
					if (p.kind !== "restart") { mapper.fail("claude stopped waiting for a tool result"); settle(); return; }
					startFlattened(p).catch((e) => { mapper.fail(`Claude relay failed to start: ${(e as Error).message}`); settle(); });
				};
				const deliver = () => { for (const r of results) host?.resolve(r.toolCallId, { content: r.content as any, isError: r.isError }); };
				handedOff = true;
				if (plan.then) {
					// claude folds a user line written while a tool call is parked into the same turn: the model sees it together with
					// the tool results and the turn still ends with one `result` (so the line is not counted in `owed`). Write it first
					// and give claude a moment to read it before the tool call returns.
					const gen = generation;
					const uuid = randomUUID();
					steers.add(uuid);
					proc!.write({ ...userLine(toClaudeUserContent(plan.then.content)), uuid });
					await new Promise<void>((r) => { if (deps.setTimer) deps.setTimer(r, STEER_LEAD_MS); else setTimeout(r, STEER_LEAD_MS); });
					if (gen === generation && !mapper.finished) deliver();
				} else deliver();
			}
		} catch (e) {
			mapper.fail(`Claude relay failed to start: ${(e as Error).message}`);
			settle();
		}

		await finished;
		req.signal?.removeEventListener("abort", onAbort);
		if (active?.mapper === mapper) active = undefined;

		const m = mapper.message;
		if (proc && (m.stopReason === "stop" || m.stopReason === "length" || m.stopReason === "toolUse")) {
			const toolCalls = m.content.filter((c) => c.type === "toolCall").map((c: any) => c.id as string);
			snapshot = { config, fingerprints: [...req.messages, m as unknown as PiMessage].map(fingerprint), pendingToolCallIds: m.stopReason === "toolUse" ? toolCalls : [] };
		} else if (m.stopReason === "error") {
			markLost("error");
			await teardown();
			// A resumed session that fails its turn may be the cause (a history claude rejects): never resume it again, replay instead.
			if (info.resumed) discardSession();
		}
		if (deps.onTurn) {
			const { input, output, cacheRead, cacheWrite } = m.usage;
			try { deps.onTurn({ ...info, usage: { input, output, cacheRead, cacheWrite }, stopReason: m.stopReason }); } catch { /* an observer must not break the turn */ }
		}
	}

	/** Forgets claude's session: its transcripts are removed and the next start replays Pi's history into a new one. */
	function discardSession() {
		snapshot = undefined;
		sessionId = undefined;
		const ids = [...sessionIds];
		sessionIds.clear();
		forget(ids);
	}

	async function close() {
		closeCount++;
		// End the in-flight request first so its stream always terminates, then tear everything down.
		if (active && !active.mapper.finished) { active.mapper.fail("Claude relay session closed", "aborted"); active.settle(); }
		const leaving = proc?.gone;
		await teardown("Claude relay session closed");
		// A claude that is still exiting writes its transcript on the way out: remove the files only once it is gone.
		if (leaving) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([leaving, new Promise<void>((r) => { timer = setTimeout(r, GONE_TIMEOUT_MS); })]);
			clearTimeout(timer);
		}
		discardSession();
	}

	function closeNow() {
		closeCount++;
		if (active && !active.mapper.finished) { active.mapper.fail("Claude relay session closed", "aborted"); active.settle(); }
		void teardown("Claude relay session closed", true).catch(() => {}); // hard-kills claude synchronously; only the host's close is async
		for (const p of dying) { try { p.kill(true); } catch { /* already gone */ } }
		dying.clear();
		discardSession();
	}

	return { stream, close, closeNow };
}
