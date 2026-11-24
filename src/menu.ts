// `/claude-relay` with no arguments opens a settings menu in Pi's own /settings style (pi-tui `SettingsList`).
// No runtime Pi imports here: the pi-tui pieces are loaded lazily (`loadTuiLib`) and injected, so the item list and the
// toggle handling are unit-testable without a terminal, and a Pi without a usable TUI falls back to the text command.
import { RESET_FORMATS, RESET_WHENS, STATUS_LABELS, type NotifyKind, type ResetFormat, type ResetWhen, type Settings, type StatusLabel } from "./settings.ts";
import { statsText, type Stats } from "./stats.ts";
import type { Timing } from "./timing.ts";

export interface MenuItem {
	id: string;
	label: string;
	description?: string;
	currentValue: string;
	values?: string[];
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void };
}

/** The pi-tui / pi-coding-agent pieces the menu needs. */
export interface TuiLib {
	SettingsList: new (items: MenuItem[], maxVisible: number, theme: unknown, onChange: (id: string, value: string) => void, onCancel: () => void) => {
		capturesViewportInput?: boolean;
		render(width: number): readonly string[];
		invalidate(): void;
		handleInput?(data: string): void;
		handleMouse?(event: unknown): unknown;
	};
	getSettingsListTheme(): unknown;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

/** Loads the TUI pieces from the host Pi; a failure means "no menu" (the caller falls back to text). */
export async function loadTuiLib(): Promise<TuiLib> {
	const [tui, pi] = await Promise.all([import("@earendil-works/pi-tui"), import("@earendil-works/pi-coding-agent")]);
	return { SettingsList: tui.SettingsList as any, truncateToWidth: tui.truncateToWidth as any, getSettingsListTheme: pi.getSettingsListTheme as any };
}

export const MENU_IDS = { warning: "notify.warning", limit: "notify.limit", usage: "status.usage", resetWhen: "status.resetWhen", resetFormat: "status.resetFormat", label: "status.label", timing: "timing", stats: "stats" } as const;
const onOff = (on: boolean) => (on ? "on" : "off");

export interface MenuDeps {
	settings: Settings;
	stats?: Pick<Stats, "summary">;
	timing?: Pick<Timing, "file" | "summary">;
	/** Called after the usage-in-status-bar switch, the reset-time settings or the label changed (saved or not), so the live footer follows at once. */
	onUsageStatus?: () => void;
	/** Defaults to `loadTuiLib`. */
	loadLib?: () => Promise<TuiLib>;
}

/** What a read-only entry shows once opened: any key goes back. */
function infoView(lines: () => string[], truncate: TuiLib["truncateToWidth"]): NonNullable<MenuItem["submenu"]> {
	return (_current, done) => {
		const text = lines();
		return {
			render: (width) => [...text, "", "(any key to go back)"].map((l) => truncate(`  ${l}`, Math.max(1, width))),
			invalidate() {},
			handleInput() { done(); },
		};
	};
}

export function menuItems(d: MenuDeps, truncate: TuiLib["truncateToWidth"]): MenuItem[] {
	const notify = d.settings.notify();
	const items: MenuItem[] = [
		{ id: MENU_IDS.warning, label: "Usage warning pop-up", description: "Pop-up when you approach a Claude usage limit.", currentValue: onOff(notify.warning), values: ["on", "off"] },
		{ id: MENU_IDS.limit, label: "Usage limit pop-up", description: "Pop-up when a Claude usage limit is reached.", currentValue: onOff(notify.limit), values: ["on", "off"] },
		{ id: MENU_IDS.usage, label: "Usage in status bar", description: "Show Claude usage (5h / 7d) in the footer status. Off shows the login line instead; pop-ups are not affected.", currentValue: onOff(d.settings.usageStatus()), values: ["on", "off"] },
		{ id: MENU_IDS.resetWhen, label: "Reset time in status bar", description: "When each usage window shows when it resets: always, only near a limit, or never. A reached limit always shows it.", currentValue: d.settings.resetWhen(), values: [...RESET_WHENS] },
		{ id: MENU_IDS.resetFormat, label: "Reset time format", description: "full \"5h 63% (resets in 52m)\" or compact \"5h 63% ↻52m\".", currentValue: d.settings.resetFormat(), values: [...RESET_FORMATS] },
		{ id: MENU_IDS.label, label: "Status bar label", description: "Prefix of the usage line: claude \"Claude 5h …\", relay \"⎍ 5h …\", loop \"🔁 5h …\", asterisk \"✳️ 5h …\", star \"✴️ 5h …\", or keycap \"*️⃣ 5h …\".", currentValue: d.settings.statusLabel(), values: [...STATUS_LABELS] },
		{ id: MENU_IDS.timing, label: "Latency timing", description: `Record per-request latency (no prompt text) to ${d.timing?.file ?? "<agent home>/claude-relay-timing.jsonl"}. Off by default.`, currentValue: onOff(d.settings.timing()), values: ["on", "off"] },
	];
	// One view for both sources, shown whenever either is wired; statsText leaves out the part whose source is missing.
	if (d.stats || d.timing) {
		const { stats, timing, settings } = d;
		items.push({ id: MENU_IDS.stats, label: "Stats", description: "Prompt cache and, while latency timing is on, latency and output rate. Enter to view.", currentValue: "view", submenu: infoView(() => statsText(stats?.summary(), timing && { on: settings.timing(), summary: timing.summary() }).split("\n"), truncate) });
	}
	return items;
}

/** Applies a value chosen in the menu through the Settings object (which persists it). Returns false when it could not be saved, undefined for an unknown id. */
export function applyMenuChange(id: string, value: string, settings: Settings): boolean | undefined {
	if (id === MENU_IDS.label) return (STATUS_LABELS as readonly string[]).includes(value) ? settings.setStatusLabel(value as StatusLabel) : undefined;
	if (id === MENU_IDS.resetWhen) return (RESET_WHENS as readonly string[]).includes(value) ? settings.setResetWhen(value as ResetWhen) : undefined;
	if (id === MENU_IDS.resetFormat) return (RESET_FORMATS as readonly string[]).includes(value) ? settings.setResetFormat(value as ResetFormat) : undefined;
	if (value !== "on" && value !== "off") return undefined;
	const on = value === "on";
	if (id === MENU_IDS.timing) return settings.setTiming(on);
	if (id === MENU_IDS.usage) return settings.setUsageStatus(on);
	const kind: NotifyKind | undefined = id === MENU_IDS.warning ? "warning" : id === MENU_IDS.limit ? "limit" : undefined;
	return kind ? settings.setNotify(kind, on) : undefined;
}

interface MenuUi {
	custom?(factory: (tui: any, theme: any, keybindings: any, done: (result: undefined) => void) => unknown): Promise<unknown>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}
export interface MenuCtx { ui?: MenuUi; hasUI?: boolean; mode?: string }

/** The menu needs the interactive terminal UI: not print/JSON/RPC mode and a `custom()` that can show a component. */
export function canOpenMenu(ctx: MenuCtx | undefined): boolean {
	return !!ctx && typeof ctx.ui?.custom === "function" && ctx.hasUI !== false && (ctx.mode === undefined || ctx.mode === "tui");
}

/** Opens the menu; resolves true once it was shown and closed, false when it is not available (the caller prints text instead). Never throws. */
export async function openRelayMenu(ctx: MenuCtx | undefined, d: MenuDeps): Promise<boolean> {
	if (!canOpenMenu(ctx)) return false;
	try {
		const lib = await (d.loadLib ?? loadTuiLib)();
		const ui = ctx!.ui!;
		await ui.custom!((tui, theme, _keybindings, done) => {
			const items = menuItems(d, lib.truncateToWidth);
			const list = new lib.SettingsList(
				items, Math.min(items.length + 2, 15), lib.getSettingsListTheme(),
				(id, value) => {
					let saved: boolean | undefined;
					try { saved = applyMenuChange(id, value, d.settings); } catch { saved = false; }
					if ((id === MENU_IDS.usage || id === MENU_IDS.resetWhen || id === MENU_IDS.resetFormat || id === MENU_IDS.label) && saved !== undefined) { try { d.onUsageStatus?.(); } catch { /* the footer must never break the menu */ } }
					if (saved === false) { try { ui.notify?.("Could not save the setting; it applies until Pi restarts.", "warning"); } catch { /* ignore */ } }
				},
				() => done(undefined),
			);
			const title = "Claude relay settings";
			return {
				capturesViewportInput: list.capturesViewportInput,
				render: (width: number) => [theme?.fg ? theme.fg("accent", theme.bold ? theme.bold(title) : title) : title, "", ...list.render(width)],
				invalidate: () => list.invalidate(),
				handleInput: (data: string) => { list.handleInput?.(data); tui?.requestRender?.(); },
				// Wheel scroll and click-to-select reach the list as in Pi's own /settings. The TUI redraws from the returned result
				// (move/hover default to no redraw), so no render is requested here: pointer moves stay free.
				handleMouse: (event: unknown) => list.handleMouse?.(event),
			};
		});
		return true;
	} catch {
		return false;
	}
}
