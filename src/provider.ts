// Pi-facing provider: keeps one relay session per Pi session id and adapts streamSimple to it.
// pi-ai functions are injected so this module has no runtime dependency on Pi.
import { createHash } from "node:crypto";
import type { RelaySession, TurnInfo } from "./session.ts";
import { createStats } from "./stats.ts";
import type { RelayEvent } from "./turn.ts";
import type { PiMessage } from "./sync.ts";
import { anthropicRateLimitHeaders } from "./rate-limit.ts";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiAiFns {
	collapseSystemMessages(context: any): any;
	getCurrentSystemPrompt(messages: any[]): string;
	getCurrentTools(messages: any[]): { name: string; description: string; parameters: unknown }[];
	createAssistantMessageEventStream(): { push(event: any): void; end(result?: any): void };
	/** Pi's own pricing of a usage for a model (fills `usage.cost`); absent in older Pi versions. */
	calculateCost?(model: any, usage: any): unknown;
}

/** What the provider knows about a settled turn: never prompt text, only hashes and counts. */
export interface TurnReport {
	sessionKey: string;
	info: TurnInfo;
	/** The session is not a registered Pi session (compaction, summaries): it is closed after its request. */
	throwaway: boolean;
	systemPromptHash: string;
	toolsHash: string;
	messages: number;
}

export interface ProviderDeps {
	piAi: PiAiFns;
	/** `onTurn` must be handed to the session (`createSession({ onTurn })`) so the provider's stats see its turns. */
	newSession: (key: string, onTurn: (info: TurnInfo) => void) => RelaySession;
	cwd: () => string;
	/** Called after the stats were updated, once per settled turn (the debug log). Errors are ignored. */
	onTurn?: (report: TurnReport) => void;
}

const sha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

export function effortFor(level: ThinkingLevel | undefined, modelReasons: boolean): string {
	if (!level || !modelReasons) return "off";
	return level === "minimal" ? "low" : level;
}

/**
 * Pi's cache warmer (`core/cache-warmer.js` -> pi-ai `getCacheWarmingRequestOptions`) re-sends a request's prefix with the
 * real sessionId, `maxTokens: 1`, `disableContinuation: true` and `maxRetries: 0`, and only records the returned usage
 * (it ignores `error`/`aborted` replies). Warming Anthropic's server-side cache is meaningless for the relay, because
 * `claude` builds its own requests, so such a request is answered locally. `maxTokens <= 1` is the marker: no real
 * conversation turn is capped at one output token.
 */
export function isCacheWarmRequest(options: { maxTokens?: number } | undefined): boolean {
	return typeof options?.maxTokens === "number" && options.maxTokens <= 1;
}

const ZERO_USAGE = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export function createRelayProvider(deps: ProviderDeps) {
	const stats = createStats();
	type Entry = { session: RelaySession; queue: Promise<void>; pending: number; request?: { systemPromptHash: string; toolsHash: string; messages: number } };
	const sessions = new Map<string, Entry>();
	/** Pi session ids whose relay session lives until `closeSession`; any other key is closed after its request. */
	const persistent = new Set<string>();

	function entry(key: string) {
		let e = sessions.get(key);
		if (!e) {
			const created: Entry = { session: undefined as unknown as RelaySession, queue: Promise.resolve(), pending: 0 };
			const onTurn = (info: TurnInfo) => {
				const throwaway = !persistent.has(key);
				stats.record(key, info, { throwaway });
				const r = created.request ?? { systemPromptHash: "", toolsHash: "", messages: 0 };
				try { deps.onTurn?.({ sessionKey: key, info, throwaway, ...r }); } catch { /* the debug log never breaks a turn */ }
			};
			created.session = deps.newSession(key, onTurn);
			e = created;
			sessions.set(key, e);
		}
		return e;
	}

	function keepSession(key: string) {
		if (key) persistent.add(key);
	}

	function streamSimple(model: any, context: any, options: any = {}) {
		const out = deps.piAi.createAssistantMessageEventStream();
		if (isCacheWarmRequest(options)) {
			stats.recordWarm();
			const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE(), stopReason: "length", timestamp: Date.now() };
			out.push({ type: "start", partial: message });
			out.push({ type: "done", reason: "length", message });
			out.end();
			return out;
		}
		const collapsed = deps.piAi.collapseSystemMessages(context);
		const systemPrompt = deps.piAi.getCurrentSystemPrompt(collapsed.messages);
		const tools = deps.piAi.getCurrentTools(collapsed.messages);
		const messages = collapsed.messages.filter((m: any) => m.role !== "system") as PiMessage[];
		const key = options.sessionId || "default";
		const e = entry(key);
		e.pending++;
		let terminal = false;
		const emit = (ev: RelayEvent) => {
			if (terminal) return;
			out.push(ev);
			if (ev.type === "done" || ev.type === "error") terminal = true;
		};
		// Pi's own Anthropic provider reports quota through `onResponse(headers)`; do the same so Pi's
		// `after_provider_response` event (footers, extensions) sees `anthropic-ratelimit-unified-*` headers.
		const onRateLimit = (info: any) => {
			if (typeof options.onResponse !== "function") return;
			const headers = anthropicRateLimitHeaders(info);
			if (!Object.keys(headers).length) return;
			try {
				Promise.resolve(options.onResponse({ status: info?.status === "rejected" ? 429 : 200, headers }, model)).catch(() => {});
			} catch { /* a failing observer must not break the turn */ }
		};
		const run = async () => {
			try {
				e.request = { systemPromptHash: sha8(systemPrompt), toolsHash: sha8(JSON.stringify(tools.map((t) => [t.name, t.description, t.parameters]))), messages: messages.length };
				await e.session.stream({ model: model.id, systemPrompt, tools, effort: effortFor(options.reasoning, !!model.reasoning), cwd: deps.cwd(), apiKey: options.apiKey, messages, signal: options.signal, throwaway: !persistent.has(key), onRateLimit, cost: (usage) => { deps.piAi.calculateCost?.(model, usage); } }, emit);
			} catch (err) {
				emit({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: (err as Error).message, timestamp: Date.now() } });
			} finally {
				out.end();
				e.pending--;
				// Compaction and summaries call with a fresh random id (or none): nobody will ever send that id again.
				if (e.pending === 0 && !persistent.has(key) && sessions.get(key) === e) {
					sessions.delete(key);
					await Promise.allSettled([e.session.close()]);
				}
			}
		};
		e.queue = e.queue.then(run, run);
		return out;
	}

	async function closeAll() {
		const all = [...sessions.values()];
		sessions.clear();
		persistent.clear();
		await Promise.allSettled(all.map((e) => e.session.close()));
	}

	/** Synchronous close of every session, for the process exit hook (an async close never finishes there). */
	function closeAllNow() {
		const all = [...sessions.values()];
		sessions.clear();
		for (const e of all) { try { e.session.closeNow(); } catch { /* keep closing the others */ } }
	}

	async function closeSession(key: string) {
		persistent.delete(key);
		const e = sessions.get(key);
		if (!e) return;
		sessions.delete(key);
		await e.session.close();
	}

	return { streamSimple, stats, keepSession, closeAll, closeAllNow, closeSession, sessionCount: () => sessions.size };
}
