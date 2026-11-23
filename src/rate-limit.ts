// Quota surfacing. `claude` emits `rate_limit_event`s; Pi's own Anthropic provider reports quota through the
// `anthropic-ratelimit-unified-*` response headers (delivered to extensions as `after_provider_response`).
// We translate the former into the latter so every Pi footer/extension that reads those headers keeps working,
// and show a short footer status plus a warning when the state is not "allowed".

import { paint, plain, themeOf, utilizationColor, type Segment } from "./footer-color.ts";
import type { ResetFormat, ResetWhen } from "./settings.ts";

const H = "anthropic-ratelimit-unified-";
const WINDOWS: Record<string, string> = { five_hour: "5h", seven_day: "7d" };
const CLAIM_NAMES: Record<string, string> = {
	five_hour: "5-hour", seven_day: "7-day", seven_day_opus: "7-day Opus", seven_day_sonnet: "7-day Sonnet", overage: "overage",
};
export const STATUS_ID = "claude-relay";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

/** claude's `rate_limit_info` → Anthropic unified rate-limit response headers. */
export function anthropicRateLimitHeaders(info: unknown): Record<string, string> {
	if (!isObj(info)) return {};
	const headers: Record<string, string> = {};
	const set = (name: string, v: unknown) => { const s = scalar(v); if (s !== undefined) headers[H + name] = s; };
	set("status", info.status);
	set("reset", info.resetsAt);
	set("representative-claim", info.rateLimitType);
	set("overage-status", info.overageStatus);
	set("overage-reset", info.overageResetsAt);
	if (isObj(info.unifiedWindows)) {
		for (const [name, abbr] of Object.entries(WINDOWS)) {
			const w = (info.unifiedWindows as Record<string, unknown>)[name];
			if (!isObj(w)) continue;
			set(`${abbr}-utilization`, w.utilization);
			set(`${abbr}-reset`, w.resetsAt);
			set(`${abbr}-status`, w.status);
		}
	}
	return headers;
}

export interface RateLimitDescription {
	status: string;
	severity: "ok" | "warning" | "error";
	/** Plain footer text (what an uncolored footer shows). */
	footer: string;
	/** The same footer as colored segments; paint them with Pi's theme. */
	segments: Segment[];
	/** Present when the user should be told (status is not "allowed"). */
	message?: string;
	/** Changes when the quota state worth notifying about changes. */
	signature: string;
}

function relative(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60), rest = minutes % 60;
	if (hours < 48) return rest ? `${hours}h ${rest}m` : `${hours}h`;
	const days = Math.floor(hours / 24), restHours = hours % 24;
	return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function clock(resetMs: number, nowMs: number): string {
	const d = new Date(resetMs);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return d.toDateString() === new Date(nowMs).toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function fraction(v: string | undefined): number | undefined {
	const n = v === undefined ? NaN : Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function percent(v: string | undefined): string | undefined {
	const n = fraction(v);
	return n === undefined ? undefined : `${Math.round(n * 100)}%`;
}

const SEP: Segment = { text: " · " };
const join = (parts: Segment[][]): Segment[] => parts.flatMap((p, i) => (i ? [SEP, ...p] : p));
const described = (status: string, severity: RateLimitDescription["severity"], signature: string, segments: Segment[], message?: string): RateLimitDescription =>
	({ status, severity, signature, segments, footer: plain(segments), ...(message ? { message } : {}) });

const resetMsOf = (v: string | undefined) => { const n = v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n * 1000 : undefined; };

/** When the footer shows reset times (`always`, only `near` a limit, or `never`) and how (`full` or `compact`). */
export interface ResetOptions { when: ResetWhen; format: ResetFormat }
export const DEFAULT_RESET: ResetOptions = { when: "always", format: "full" };

/**
 * Footer segments for the usage windows. A window `show` picks gets its own reset time (`(resets in 52m)` / `↻52m`),
 * colored `warning` while the state is a warning; a window without a reset time shows only its utilization.
 */
function windowSegments(get: (name: string) => string | undefined, nowMs: number, show: (abbr: string) => boolean, format: ResetFormat, warn: boolean): { segments: Segment[][]; withReset: boolean } {
	let withReset = false;
	const segments = ["5h", "7d"].flatMap((abbr) => {
		const u = get(`${abbr}-utilization`), p = percent(u);
		if (!p) return [];
		const seg: Segment[] = [{ text: `${abbr} ${p}`, color: utilizationColor(fraction(u)!) }];
		const ms = !show(abbr) ? undefined : resetMsOf(get(`${abbr}-reset`));
		if (ms !== undefined) {
			withReset = true;
			const rel = relative(ms - nowMs);
			const text = format === "compact" ? `↻${rel}` : `(resets in ${rel})`;
			seg.push({ text: " " }, warn ? { text, color: "warning" } : { text });
		}
		return [seg];
	});
	return { segments, withReset };
}

/**
 * `reset` chooses when (`always` by default, only `near` a limit, or `never`) and how (`full` by default, or `compact`) the footer shows
 * each window's reset time. A reached limit always shows its reset time.
 */
export function describeRateLimitHeaders(headers: Record<string, string>, nowMs = Date.now(), reset: ResetOptions = DEFAULT_RESET): RateLimitDescription | undefined {
	const get = (name: string) => headers[H + name];
	const status = get("status");
	if (!status) return undefined;
	const claim = get("representative-claim");
	const claimName = claim ? CLAIM_NAMES[claim] ?? claim : undefined;
	const warn = status !== "allowed" && status !== "rejected";
	const show = reset.when === "always" || (reset.when === "near" && warn);
	// `near`: only the windows near their own limit (their own status is not `allowed`); every window when none reports a status.
	const statuses = ["5h", "7d"].map((abbr) => get(`${abbr}-status`)).filter((s) => s !== undefined);
	const nearWindow = (abbr: string) => statuses.length === 0 || (get(`${abbr}-status`) ?? "allowed") !== "allowed";
	const { segments: windows, withReset } = windowSegments(get, nowMs, (abbr) => show && (reset.when === "always" || nearWindow(abbr)), reset.format, warn);
	const resetSec = Number(get("reset"));
	const resetMs = get("reset") && Number.isFinite(resetSec) ? resetSec * 1000 : undefined;
	const resetRel = resetMs === undefined ? undefined : relative(resetMs - nowMs);
	const resetText = resetMs === undefined ? "" : ` Resets in ${resetRel} (${clock(resetMs, nowMs)}).`;
	const signature = `${status}|${claim ?? ""}|${get("reset") ?? ""}`;

	if (status === "rejected") {
		return described(status, "error", signature,
			[{ text: `Claude limit reached${resetRel ? ` · resets in ${resetRel}` : ""}`, color: "error" }],
			`Claude usage limit reached${claimName ? ` (${claimName} window)` : ""}.${resetText} Requests will fail until then.`);
	}
	if (status === "allowed") {
		return described(status, "ok", signature, [{ text: "Claude " }, ...(windows.length ? join(windows) : [{ text: "ok", color: "success" as const }])]);
	}
	const claimPct = percent(get(`${claim === "seven_day" ? "7d" : "5h"}-utilization`));
	// The overall reset time is only a fallback for when no window shows its own.
	const parts = [...windows, ...(resetRel && show && !withReset ? [[{ text: `resets in ${resetRel}`, color: "warning" as const }]] : [])];
	return described(status, "warning", signature,
		[{ text: "Claude " }, ...(parts.length ? join(parts) : [{ text: status, color: "warning" as const }])],
		`Claude usage warning${claimName ? ` (${claimName} window)` : ""}${claimPct ? `: ${claimPct} used` : ""}.${resetText}`);
}

interface UiLike { setStatus?(id: string, text: string | undefined): void; notify?(message: string, type?: "info" | "warning" | "error"): void; readonly theme?: unknown }

/**
 * `after_provider_response` handler: footer on every response carrying Anthropic unified headers (unless `usageStatus` is off), notify on state changes
 * (each pop-up kind can be switched off on its own; the footer switch does not affect them).
 * The last usage seen is kept even while the footer is off (its reset times are recomputed on refresh); `refresh(ctx)` re-applies the footer after the switch changed:
 * usage on and one seen → that usage; otherwise `login(ctx)` puts the login line back (the line session start shows under the same status id).
 */
export function createRateLimitHandler(opts: { now?: () => number; notifications?: () => { warning: boolean; limit: boolean }; usageStatus?: () => boolean; reset?: () => ResetOptions; login?: (ctx: { ui?: UiLike }) => void } = {}) {
	let lastNotified: string | undefined;
	let lastHeaders: Record<string, string> | undefined;
	const describe = (headers: Record<string, string>) => describeRateLimitHeaders(headers, (opts.now ?? Date.now)(), opts.reset?.() ?? DEFAULT_RESET);
	const handler = (event: { status?: number; headers?: Record<string, string> }, ctx: { ui?: UiLike }) => {
		const d = describe(event?.headers ?? {});
		if (!d) return;
		lastHeaders = event!.headers!;
		try {
			if (opts.usageStatus?.() ?? true) ctx.ui?.setStatus?.(STATUS_ID, paint(d.segments, themeOf(ctx)));
			const enabled = opts.notifications?.() ?? { warning: true, limit: true };
			const wanted = d.severity === "error" ? enabled.limit : enabled.warning;
			if (d.message && wanted && d.signature !== lastNotified) ctx.ui?.notify?.(d.message, d.severity === "error" ? "error" : "warning");
			// A muted state is not remembered, so it is announced once its switch is turned back on.
			lastNotified = d.message && wanted ? d.signature : undefined;
		} catch { lastNotified = d.message ? d.signature : undefined; /* UI problems must never break a turn */ }
	};
	handler.refresh = (ctx: { ui?: UiLike } | undefined) => {
		try {
			// Re-described from the last headers: the reset times count from now and follow the current display settings.
			const d = lastHeaders && describe(lastHeaders);
			if ((opts.usageStatus?.() ?? true) && d) ctx?.ui?.setStatus?.(STATUS_ID, paint(d.segments, themeOf(ctx)));
			else if (ctx) opts.login?.(ctx);
		} catch { /* UI problems must never break a command */ }
	};
	return handler;
}

// Pi classifies assistant errors as retryable with /rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])/ etc.
// (pi-ai utils/retry.js). Make sure claude's transient rate-limit errors carry such a marker so normal retry/backoff applies.
// An exhausted usage window (5-hour, weekly) resets in hours, far beyond Pi's backoff: it is worded with `quota exceeded`,
// one of Pi's non-retryable patterns, so Pi fails fast instead of spawning claude again for each retry.
const PI_RETRYABLE_RATE_LIMIT = /rate.?limit|too many requests|(?<![a-z0-9])429(?![a-z0-9])/i;
const PI_NON_RETRYABLE_QUOTA = /quota exceeded/i;
const CLAUDE_QUOTA_WORDING = /hit your (?:[\w-]+ )?limit|usage limit/i;
const CLAUDE_LIMIT_WORDING = /limit reached/i;

export function retryableRateLimitMessage(text: string, result: { api_error_status?: unknown }, lastStatus?: string): string {
	if (lastStatus === "rejected" || CLAUDE_QUOTA_WORDING.test(text)) return PI_NON_RETRYABLE_QUOTA.test(text) ? text : `429 quota exceeded: ${text}`;
	if (PI_RETRYABLE_RATE_LIMIT.test(text)) return text;
	if (result.api_error_status === 429 || CLAUDE_LIMIT_WORDING.test(text)) return `429 rate limit: ${text}`;
	return text;
}
