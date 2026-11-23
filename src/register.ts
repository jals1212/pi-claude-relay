// Wiring between Pi's extension API and the relay provider. Free of runtime Pi imports
// (pi-ai functions are injected) so the registration contract is unit-testable.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRelayProvider, type PiAiFns, type TurnReport } from "./provider.ts";
import { createSession, type RelaySession, type TurnInfo } from "./session.ts";
import { createMcpHost } from "./mcp-host.ts";
import { spawnClaude, removeSessionTranscripts, sweepStaleTranscripts } from "./claude-process.ts";
import { createRateLimitHandler, STATUS_ID } from "./rate-limit.ts";
import { paint, themeOf, type Segment } from "./footer-color.ts";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSettings, relayArgumentCompletions, runRelayCommand } from "./settings.ts";
import { createTiming } from "./timing.ts";
import { openRelayMenu, type TuiLib } from "./menu.ts";
import { API, PROVIDER, providerConfig, relayEnabled } from "./config.ts";

export interface RegisterDeps {
	piAi: PiAiFns;
	env?: NodeJS.ProcessEnv;
	cwd?: () => string;
	/** Where claude keeps its state for this Pi space; defaults to `<agent home>/claude-relay`. */
	configDir?: string;
	/** Per-space relay settings file; defaults to `<agent home>/claude-relay-settings.json`. */
	settingsFile?: string;
	/** Latency timing log; defaults to `<agent home>/claude-relay-timing.jsonl`. */
	timingFile?: string;
	/** Test seam: replaces the pi-tui loader of the `/claude-relay` menu. */
	loadTuiLib?: () => Promise<TuiLib>;
	/** Test seam: replaces the claude-backed session factory. */
	newSession?: (key: string, onTurn: (info: TurnInfo) => void) => RelaySession;
}

/** `PI_CLAUDE_RELAY_DEBUG_LOG=<file>`: one JSON line per settled turn, hashes and counts only (never prompt text, tool arguments, credentials or the MCP URL). */
function debugLogWriter(env: NodeJS.ProcessEnv) {
	return (r: TurnReport) => {
		const file = env.PI_CLAUDE_RELAY_DEBUG_LOG;
		if (!file) return;
		try {
			const { plan, reason, stopReason, usage } = r.info;
			const line = { t: Date.now(), session: createHash("sha256").update(r.sessionKey).digest("hex").slice(0, 8), plan, reason, stopReason, usage, systemPromptHash: r.systemPromptHash, toolsHash: r.toolsHash, messages: r.messages };
			appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
		} catch { /* a debug log must never break a turn */ }
	};
}

/** Removes the transcripts now and once more shortly after: a claude process killed a moment ago may still flush its transcript while it exits. */
function removeTranscriptsLater(configDir: string, ids: string[]) {
	removeSessionTranscripts(configDir, ids);
	setTimeout(() => removeSessionTranscripts(configDir, ids), 2000).unref?.();
}

/** The provider of the most recent factory run; Pi runs the extension factory again on every /reload and /new. */
type Closable = { closeAll(): Promise<void>; closeAllNow?(): void };
let current: Closable | undefined;
/** Transcripts untouched for this long belong to a Pi that crashed or was killed: removed when the relay starts. */
const STALE_TRANSCRIPT_MS = 7 * 24 * 60 * 60 * 1000;
const exitHooked = new WeakSet<object>();

/** Closes the previous factory run's sessions and makes `provider` the one closed at process exit; the exit listener is registered once per process. */
export function adoptProvider(provider: Closable | undefined, proc: Pick<NodeJS.Process, "once"> = process) {
	const previous = current;
	current = provider;
	if (previous && previous !== provider) void previous.closeAll().catch(() => {});
	if (!exitHooked.has(proc)) {
		exitHooked.add(proc);
		// Only synchronous work runs in an exit handler: kill claude and remove the transcripts now.
		proc.once("exit", () => { if (current?.closeAllNow) current.closeAllNow(); else void current?.closeAll(); });
	}
}

/** Registers the relay over Pi's `anthropic` provider; returns undefined (registers nothing) when opted out. */
export function registerRelay(pi: Pick<ExtensionAPI, "registerProvider" | "on" | "registerCommand">, deps: RegisterDeps) {
	if (!relayEnabled(deps.env ?? process.env)) return undefined;
	const env = deps.env ?? process.env;
	const agentHome = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const configDir = deps.configDir ?? join(agentHome, "claude-relay");
	const settings = createSettings(deps.settingsFile ?? join(agentHome, "claude-relay-settings.json"));
	sweepStaleTranscripts(configDir, STALE_TRANSCRIPT_MS);
	const timing = createTiming({ file: deps.timingFile ?? join(agentHome, "claude-relay-timing.jsonl"), enabled: () => settings.timing() });
	const writeDebugLog = debugLogWriter(env);
	const provider = createRelayProvider({
		piAi: deps.piAi,
		cwd: deps.cwd ?? (() => process.cwd()),
		newSession: deps.newSession ?? ((_key, onTurn) => createSession({ spawn: (o) => spawnClaude(o, undefined, configDir), removeTranscripts: (ids) => removeTranscriptsLater(configDir, ids), createHost: (tools) => createMcpHost({ tools }), api: API, provider: PROVIDER, onTurn, timing: () => settings.timing() })),
		onTurn: (report) => { writeDebugLog(report); timing.record(report); },
	});
	pi.registerProvider(PROVIDER, providerConfig(provider.streamSimple) as any);
	// The login line (session start) and the usage line share one status id: the handler restores the login line when the usage switch goes off.
	let lastLogin: Segment[] | undefined;
	const showLogin = (ctx: any) => { lastLogin = showLoginStatus(ctx, lastLogin); };
	const rateLimit = createRateLimitHandler({ notifications: () => settings.notify(), usageStatus: () => settings.usageStatus(), login: showLogin });
	pi.on("after_provider_response", rateLimit as any);
	pi.registerCommand("claude-relay", {
		description: "Claude relay settings menu (no arguments), prompt-cache stats, latency timing and usage in the status bar: /claude-relay [notify [warning|limit] [on|off] | stats | timing [on|off] | status [on|off]]",
		getArgumentCompletions: relayArgumentCompletions,
		handler: async (args, ctx) => {
			// No arguments in an interactive Pi: the settings menu; anywhere else (or if it cannot open) the text command.
			if (!args.trim() && await openRelayMenu(ctx as any, { settings, stats: provider.stats, timing, loadLib: deps.loadTuiLib, onUsageStatus: () => rateLimit.refresh(ctx as any) })) return;
			runRelayCommand(args, settings, ctx?.ui as any, provider.stats, timing, () => rateLimit.refresh(ctx as any));
		},
	});
	pi.on("session_start", (_event, ctx) => {
		// Only Pi's own session ids keep a claude process alive; compaction and summaries use throwaway ids.
		try { const id = ctx?.sessionManager?.getSessionId?.(); if (id) provider.keepSession(id); } catch { /* ignore */ }
		showLogin(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await provider.closeSession(ctx.sessionManager.getSessionId());
	});
	return provider;
}

/** Footer text for the Pi space's Anthropic login, the credential the relay hands to claude. */
export function loginStatusSegments(configured: boolean, oauth: boolean): Segment[] {
	if (!configured) return [{ text: "✗ Claude relay · no Anthropic login in this space (/login)", color: "error" }];
	return [{ text: `✓ Claude relay · ${oauth ? "subscription" : "API key"}` }];
}

/** Plain-text form of the login footer. */
export function loginStatusText(configured: boolean, oauth: boolean): string {
	return loginStatusSegments(configured, oauth).map((s) => s.text).join("");
}

/**
 * Shows the relay and the space's login at session start, before the first response brings usage figures (and again when the usage footer is switched off).
 * Reads auth status only, never the credential. Returns the line shown; when the status cannot be read it shows `previous` (the last line shown), if any,
 * and with neither it clears the status, so a usage line the user switched off never stays in the footer.
 */
function showLoginStatus(ctx: any, previous?: Segment[]): Segment[] | undefined {
	if (!ctx?.ui?.setStatus) return previous;
	let segments = previous;
	try {
		const registry = ctx.modelRegistry;
		if (registry) {
			const configured = !!registry.getProviderAuthStatus?.(PROVIDER)?.configured;
			const model = ctx.model?.provider === PROVIDER ? ctx.model : (registry.getAll?.() ?? []).find((m: any) => m.provider === PROVIDER);
			const oauth = configured && !!model && !!registry.isUsingOAuth?.(model);
			segments = loginStatusSegments(configured, oauth);
		}
	} catch { /* unreadable auth status: fall back to the last line shown */ segments = previous; }
	try { ctx.ui.setStatus(STATUS_ID, segments ? paint(segments, themeOf(ctx)) : undefined); } catch { /* the footer must never break a session */ }
	return segments;
}
