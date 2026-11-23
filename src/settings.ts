// Per-space relay settings, persisted as JSON next to the space's other agent state
// (`<agent home>/claude-relay-settings.json`). Loading never throws: a missing or corrupt file means defaults.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { statsText, type Stats } from "./stats.ts";
import { timingStateText, type Timing } from "./timing.ts";

export interface NotifySettings {
	/** Pop-up for the approaching-limit warning ("Claude usage warning…"). */
	warning: boolean;
	/** Pop-up for the limit-reached error ("Claude usage limit reached…"). */
	limit: boolean;
}
export type NotifyKind = keyof NotifySettings;
export const DEFAULT_NOTIFY: NotifySettings = { warning: true, limit: true };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readRaw(file: string): Record<string, unknown> {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return isObj(raw) ? raw : {};
	} catch {
		return {};
	}
}

function toNotify(raw: Record<string, unknown>): NotifySettings {
	const n = isObj(raw.notify) ? raw.notify : {};
	return {
		warning: typeof n.warning === "boolean" ? n.warning : DEFAULT_NOTIFY.warning,
		limit: typeof n.limit === "boolean" ? n.limit : DEFAULT_NOTIFY.limit,
	};
}

/** Latency timing is opt-in: a missing, unreadable or non-boolean field means off. */
function toTiming(raw: Record<string, unknown>): boolean {
	return raw.timing === true;
}

/** The usage figures in the footer status are on by default: a missing, unreadable or non-boolean `status.usage` means on. */
function toUsageStatus(raw: Record<string, unknown>): boolean {
	const s = isObj(raw.status) ? raw.status : {};
	return typeof s.usage === "boolean" ? s.usage : true;
}

export interface Settings {
	/** Current values (a copy). */
	notify(): NotifySettings;
	/** Updates the in-memory value and persists; returns false when the file could not be written. */
	setNotify(kind: NotifyKind, on: boolean): boolean;
	/** Whether per-request latency timing is on (default off). A plain boolean read: it is checked on every request. */
	timing(): boolean;
	/** Updates the in-memory value and persists; returns false when the file could not be written. */
	setTiming(on: boolean): boolean;
	/** Whether the Claude usage figures (`Claude 5h 48% · 7d 73%`) are shown in the footer status (default on). Read on every response. */
	usageStatus(): boolean;
	/** Updates the in-memory value and persists; returns false when the file could not be written. */
	setUsageStatus(on: boolean): boolean;
}

/** Temp file in the same directory (0600), then rename: readers never see a half-written file. */
function writeAtomic(file: string, text: string) {
	const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	} catch (e) {
		try { unlinkSync(tmp); } catch { /* never created or already moved */ }
		throw e;
	}
}

export function createSettings(file: string): Settings {
	const loaded = readRaw(file);
	const notify = toNotify(loaded);
	let timing = toTiming(loaded);
	let usageStatus = toUsageStatus(loaded);
	/**
	 * Re-reads the file (another Pi process may have changed another switch) and writes `change(raw)` over it, keeping every other key.
	 * `sync` takes the saved values back only for the setting being changed: another setting whose own save failed keeps its in-memory value.
	 */
	function persist(change: (raw: Record<string, unknown>) => Record<string, unknown>, sync: (merged: Record<string, unknown>) => void): boolean {
		try {
			mkdirSync(dirname(file), { recursive: true });
			let isLink = false;
			try { isLink = lstatSync(file).isSymbolicLink(); } catch { /* missing file: fine */ }
			if (isLink) return false; // never write through (or replace) a symlinked settings file
			const merged = change(readRaw(file));
			writeAtomic(file, JSON.stringify(merged, null, 2) + "\n");
			sync(merged);
			return true;
		} catch {
			return false;
		}
	}
	return {
		notify: () => ({ ...notify }),
		setNotify(kind, on) {
			notify[kind] = on;
			// Another Pi process may have changed the other switch since we loaded: change only ours.
			return persist(
				(raw) => ({ ...raw, notify: { ...(isObj(raw.notify) ? raw.notify : {}), ...toNotify(raw), [kind]: on } }),
				(merged) => { Object.assign(notify, toNotify(merged)); },
			);
		},
		timing: () => timing,
		setTiming(on) {
			timing = on;
			return persist((raw) => ({ ...raw, timing: on }), (merged) => { timing = toTiming(merged); });
		},
		usageStatus: () => usageStatus,
		setUsageStatus(on) {
			usageStatus = on;
			return persist(
				(raw) => ({ ...raw, status: { ...(isObj(raw.status) ? raw.status : {}), usage: on } }),
				(merged) => { usageStatus = toUsageStatus(merged); },
			);
		},
	};
}

export const notifyStateLine = (n: NotifySettings) => `Claude relay notifications: warning ${n.warning ? "on" : "off"}, limit ${n.limit ? "on" : "off"}`;
export const usageStatusStateLine = (on: boolean) => `Claude relay usage in status bar: ${on ? "on" : "off"}`;
export const COMMAND_USAGE = "Usage: /claude-relay notify [warning|limit] [on|off] | stats | timing [on|off] | status [on|off]";

interface NotifyUi { notify?(message: string, type?: "info" | "warning" | "error"): void }

/** Handler for `/claude-relay <args>`. */
export function runRelayCommand(args: string, settings: Settings, ui: NotifyUi | undefined, stats?: Pick<Stats, "summary">, timing?: Pick<Timing, "file" | "summary">, onUsageStatus?: () => void): void {
	const say = (message: string, type: "info" | "warning") => { try { ui?.notify?.(message, type); } catch { /* UI problems never break a command */ } };
	const [cmd, kind, value, ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (cmd === "stats" && stats && kind === undefined) return say(statsText(stats.summary()), "info");
	if (cmd === "timing") {
		if (kind === undefined) return say(timingStateText(settings.timing(), timing?.file, timing?.summary()), "info");
		if ((kind !== "on" && kind !== "off") || value !== undefined) return say(COMMAND_USAGE, "warning");
		const saved = settings.setTiming(kind === "on");
		say(timingStateText(settings.timing(), timing?.file, timing?.summary()), "info");
		if (!saved) say("Could not save the setting; it applies until Pi restarts.", "warning");
		return;
	}
	if (cmd === "status") {
		if (kind === undefined) return say(usageStatusStateLine(settings.usageStatus()), "info");
		if ((kind !== "on" && kind !== "off") || value !== undefined) return say(COMMAND_USAGE, "warning");
		const saved = settings.setUsageStatus(kind === "on");
		try { onUsageStatus?.(); } catch { /* the footer must never break a command */ }
		say(usageStatusStateLine(settings.usageStatus()), "info");
		if (!saved) say("Could not save the setting; it applies until Pi restarts.", "warning");
		return;
	}
	if (cmd !== "notify") return say(COMMAND_USAGE, "warning");
	if (kind === undefined) return say(notifyStateLine(settings.notify()), "info");
	if ((kind !== "warning" && kind !== "limit") || (value !== "on" && value !== "off") || rest.length) return say(COMMAND_USAGE, "warning");
	const saved = settings.setNotify(kind, value === "on");
	say(notifyStateLine(settings.notify()), "info");
	if (!saved) say("Could not save the setting; it applies until Pi restarts.", "warning");
}

/** Completions for the text after `/claude-relay `. */
export function relayArgumentCompletions(prefix: string): { value: string; label: string }[] | null {
	const parts = prefix.split(/\s+/);
	const last = parts.pop() ?? "";
	const head = parts.join(" ");
	const options = parts.length === 0 ? ["notify", "stats", "timing", "status"]
		: parts.length === 1 && (parts[0] === "timing" || parts[0] === "status") ? ["on", "off"]
		: parts.length === 1 && parts[0] === "notify" ? ["warning", "limit"]
		: parts.length === 2 && parts[0] === "notify" && (parts[1] === "warning" || parts[1] === "limit") ? ["on", "off"]
		: [];
	const items = options.filter((o) => o.startsWith(last)).map((o) => ({ value: head ? `${head} ${o}` : o, label: o }));
	return items.length ? items : null;
}
