// Per-space relay settings, persisted as JSON next to the space's other agent state
// (`<agent home>/claude-relay-settings.json`). Loading never throws: a missing or corrupt file means defaults.
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { statsText, type Stats } from "./stats.ts";

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

export interface Settings {
	/** Current values (a copy). */
	notify(): NotifySettings;
	/** Updates the in-memory value and persists; returns false when the file could not be written. */
	setNotify(kind: NotifyKind, on: boolean): boolean;
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
	const notify = toNotify(readRaw(file));
	return {
		notify: () => ({ ...notify }),
		setNotify(kind, on) {
			notify[kind] = on;
			try {
				mkdirSync(dirname(file), { recursive: true });
				let isLink = false;
				try { isLink = lstatSync(file).isSymbolicLink(); } catch { /* missing file: fine */ }
				if (isLink) return false; // never write through (or replace) a symlinked settings file
				// Another Pi process may have changed the other switch since we loaded: re-read and change only ours.
				const raw = readRaw(file);
				const merged = { ...raw, notify: { ...(isObj(raw.notify) ? raw.notify : {}), ...toNotify(raw), [kind]: on } };
				writeAtomic(file, JSON.stringify(merged, null, 2) + "\n");
				Object.assign(notify, toNotify(merged));
				return true;
			} catch {
				return false;
			}
		},
	};
}

export const notifyStateLine = (n: NotifySettings) => `Claude relay notifications: warning ${n.warning ? "on" : "off"}, limit ${n.limit ? "on" : "off"}`;
export const COMMAND_USAGE = "Usage: /claude-relay notify [warning|limit] [on|off] | stats";

interface NotifyUi { notify?(message: string, type?: "info" | "warning" | "error"): void }

/** Handler for `/claude-relay <args>`. */
export function runRelayCommand(args: string, settings: Settings, ui: NotifyUi | undefined, stats?: Pick<Stats, "summary">): void {
	const say = (message: string, type: "info" | "warning") => { try { ui?.notify?.(message, type); } catch { /* UI problems never break a command */ } };
	const [cmd, kind, value, ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (cmd === "stats" && stats && kind === undefined) return say(statsText(stats.summary()), "info");
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
	const options = parts.length === 0 ? ["notify", "stats"]
		: parts.length === 1 && parts[0] === "notify" ? ["warning", "limit"]
		: parts.length === 2 && parts[0] === "notify" && (parts[1] === "warning" || parts[1] === "limit") ? ["on", "off"]
		: [];
	const items = options.filter((o) => o.startsWith(last)).map((o) => ({ value: head ? `${head} ${o}` : o, label: o }));
	return items.length ? items : null;
}
