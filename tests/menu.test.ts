import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMenuChange, canOpenMenu, menuItems, openRelayMenu, MENU_IDS, type MenuItem, type TuiLib } from "../src/menu.ts";
import { createSettings } from "../src/settings.ts";
import { createStats } from "../src/stats.ts";
import { createTiming } from "../src/timing.ts";

const truncate: TuiLib["truncateToWidth"] = (text, width) => text.slice(0, width);

/** Stands in for pi-tui's SettingsList: keeps what the menu passed so a test can drive it. */
class FakeList {
	static last: FakeList;
	capturesViewportInput = true;
	inputs: string[] = [];
	items: MenuItem[]; maxVisible: number; theme: unknown; onChange: (id: string, v: string) => void; onCancel: () => void;
	constructor(items: MenuItem[], maxVisible: number, theme: unknown, onChange: (id: string, v: string) => void, onCancel: () => void) {
		this.items = items; this.maxVisible = maxVisible; this.theme = theme; this.onChange = onChange; this.onCancel = onCancel; FakeList.last = this;
	}
	render(width: number) { return this.items.map((i) => `${i.label}: ${i.currentValue}`.slice(0, width)); }
	invalidate() {}
	handleInput(d: string) { this.inputs.push(d); }
	mice: unknown[] = [];
	handleMouse(e: unknown) { this.mice.push(e); return { handled: true }; }
}
const lib: TuiLib = { SettingsList: FakeList as any, getSettingsListTheme: () => "THEME", truncateToWidth: truncate };

function rig(over: { ui?: any; mode?: string; hasUI?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "relay-menu-"));
	const file = join(dir, "s.json");
	const settings = createSettings(file);
	const stats = createStats();
	const timing = createTiming({ file: join(dir, "t.jsonl"), enabled: () => settings.timing(), append: async () => {} });
	const notes: [string, string | undefined][] = [];
	let component: any; let closed = 0; let rendered = 0;
	const ctx = {
		mode: over.mode ?? "tui", hasUI: over.hasUI ?? true,
		ui: over.ui ?? {
			notify: (m: string, t?: string) => notes.push([m, t]),
			custom: async (factory: any) => { component = factory({ requestRender: () => rendered++ }, { fg: (_c: string, t: string) => `<${t}>`, bold: (t: string) => t }, {}, () => closed++); return undefined; },
		},
	};
	return { dir, file, settings, stats, timing, notes, ctx, deps: { settings, stats, timing, loadLib: async () => lib }, component: () => component, closed: () => closed, rendered: () => rendered, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("menu items: both pop-ups and timing as on/off toggles with the current values; timing's description names the log file", () => {
	const r = rig();
	try {
		r.settings.setNotify("limit", false);
		const items = menuItems(r.deps, truncate);
		const byId = Object.fromEntries(items.map((i) => [i.id, i]));
		assert.deepEqual([byId[MENU_IDS.warning].label, byId[MENU_IDS.warning].currentValue, byId[MENU_IDS.warning].values], ["Usage warning pop-up", "on", ["on", "off"]]);
		assert.deepEqual([byId[MENU_IDS.limit].label, byId[MENU_IDS.limit].currentValue], ["Usage limit pop-up", "off"]);
		assert.deepEqual([byId[MENU_IDS.timing].label, byId[MENU_IDS.timing].currentValue], ["Latency timing", "off"]);
		assert.ok(byId[MENU_IDS.timing].description!.includes(r.timing.file));
		assert.ok(byId[MENU_IDS.stats].submenu && byId[MENU_IDS.latency].submenu);
	} finally { r.done(); }
});

test("toggling an item goes through Settings and persists; an unknown id or value changes nothing", () => {
	const r = rig();
	try {
		assert.equal(applyMenuChange(MENU_IDS.warning, "off", r.settings), true);
		assert.equal(applyMenuChange(MENU_IDS.timing, "on", r.settings), true);
		assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")), { notify: { warning: false, limit: true }, timing: true });
		assert.equal(applyMenuChange(MENU_IDS.timing, "off", r.settings), true);
		assert.equal(createSettings(r.file).timing(), false);
		assert.equal(applyMenuChange("nope", "on", r.settings), undefined);
		assert.equal(applyMenuChange(MENU_IDS.limit, "maybe", r.settings), undefined);
		assert.deepEqual(createSettings(r.file).notify(), { warning: false, limit: true });
	} finally { r.done(); }
});

test("the read-only entries open a view of the cache stats and the timing summary; any key goes back; lines fit the width", () => {
	const r = rig();
	try {
		const items = menuItems(r.deps, truncate);
		let backs = 0;
		const stats = items.find((i) => i.id === MENU_IDS.stats)!.submenu!("view", () => backs++);
		const lines = stats.render(30);
		assert.ok(lines[0].includes("Claude relay stats: 0 turns"));
		assert.ok(lines.every((l) => l.length <= 30));
		stats.handleInput("x");
		assert.equal(backs, 1);
		const latency = items.find((i) => i.id === MENU_IDS.latency)!.submenu!("view", () => {});
		assert.ok(latency.render(80).some((l) => l.includes("No timed requests yet.")));
	} finally { r.done(); }
});

test("openRelayMenu: shows a SettingsList; a change persists, Esc closes, input re-renders; a failed save warns", async () => {
	const r = rig();
	try {
		assert.equal(await openRelayMenu(r.ctx, r.deps), true);
		const list = FakeList.last;
		assert.equal(list.theme, "THEME");
		const c = r.component();
		assert.equal(c.render(40)[0], "<Claude relay settings>");
		list.onChange(MENU_IDS.timing, "on");
		assert.equal(r.settings.timing(), true);
		assert.equal(JSON.parse(readFileSync(r.file, "utf8")).timing, true);
		c.handleInput("x");
		assert.deepEqual(list.inputs, ["x"]);
		assert.equal(r.rendered(), 1);
		// the mouse reaches the list too (wheel scroll, click to select), and the list's answer goes back to the TUI
		const click = { type: "press", x: 2, y: 3 };
		assert.deepEqual(c.handleMouse?.(click), { handled: true });
		assert.deepEqual(list.mice, [click]);
		assert.equal(r.rendered(), 1, "the TUI redraws from the list's result; the menu requests no extra render per mouse event");
		list.onCancel();
		assert.equal(r.closed(), 1);
		assert.deepEqual(r.notes, []);
		// a save failure keeps the in-memory change and says so
		const failing = { ...r.deps, settings: { ...r.settings, setNotify: () => false } as any };
		await openRelayMenu(r.ctx, failing);
		FakeList.last.onChange(MENU_IDS.limit, "off");
		assert.deepEqual(r.notes, [["Could not save the setting; it applies until Pi restarts.", "warning"]]);
	} finally { r.done(); }
});

test("without a usable UI the menu is not opened (text fallback): no ctx, print/rpc mode, no custom(), hasUI false, loader failure", async () => {
	const r = rig();
	try {
		assert.equal(canOpenMenu(r.ctx), true);
		for (const ctx of [undefined, { ...r.ctx, mode: "print" }, { ...r.ctx, mode: "rpc" }, { ...r.ctx, hasUI: false }, { mode: "tui", hasUI: true, ui: { notify() {} } }]) {
			assert.equal(canOpenMenu(ctx as any), false);
			assert.equal(await openRelayMenu(ctx as any, r.deps), false);
		}
		assert.equal(await openRelayMenu(r.ctx, { ...r.deps, loadLib: async () => { throw new Error("no pi-tui"); } }), false);
		assert.equal(await openRelayMenu({ ...r.ctx, ui: { custom: async () => { throw new Error("tui"); } } }, r.deps), false);
	} finally { r.done(); }
});

test("menu: 'Usage in status bar' is an on/off toggle, on by default, ahead of timing", () => {
	const r = rig();
	try {
		let items = menuItems(r.deps, truncate);
		const item = items.find((i) => i.id === MENU_IDS.usage)!;
		assert.deepEqual([item.label, item.currentValue, item.values], ["Usage in status bar", "on", ["on", "off"]]);
		assert.ok(items.findIndex((i) => i.id === MENU_IDS.usage) < items.findIndex((i) => i.id === MENU_IDS.timing));
		r.settings.setUsageStatus(false);
		items = menuItems(r.deps, truncate);
		assert.equal(items.find((i) => i.id === MENU_IDS.usage)!.currentValue, "off");
	} finally { r.done(); }
});

test("applyMenuChange toggles usage status and persists it; other keys are kept", () => {
	const r = rig();
	try {
		assert.equal(applyMenuChange(MENU_IDS.usage, "off", r.settings), true);
		assert.equal(r.settings.usageStatus(), false);
		assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")), { status: { usage: false } });
		assert.equal(applyMenuChange(MENU_IDS.timing, "on", r.settings), true);
		assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")), { status: { usage: false }, timing: true });
		assert.equal(applyMenuChange(MENU_IDS.usage, "on", r.settings), true);
		assert.equal(createSettings(r.file).usageStatus(), true);
		assert.equal(applyMenuChange(MENU_IDS.usage, "maybe", r.settings), undefined);
		assert.equal(createSettings(r.file).usageStatus(), true);
	} finally { r.done(); }
});

test("openRelayMenu: toggling usage status applies it at once (hook runs after the save, only for that item); a failed save still applies and warns", async () => {
	const r = rig();
	try {
		const seen: boolean[] = [];
		const deps = { ...r.deps, onUsageStatus: () => seen.push(r.settings.usageStatus()) };
		await openRelayMenu(r.ctx, deps);
		FakeList.last.onChange(MENU_IDS.timing, "on");
		assert.deepEqual(seen, []);
		FakeList.last.onChange(MENU_IDS.usage, "off");
		assert.deepEqual(seen, [false]);
		assert.equal(JSON.parse(readFileSync(r.file, "utf8")).status.usage, false);
		FakeList.last.onChange(MENU_IDS.usage, "on");
		assert.deepEqual(seen, [false, true]);
		assert.deepEqual(r.notes, []);
		// a hook that throws never breaks the menu
		await openRelayMenu(r.ctx, { ...r.deps, onUsageStatus: () => { throw new Error("ui"); } });
		assert.doesNotThrow(() => FakeList.last.onChange(MENU_IDS.usage, "off"));
		// failed save: reported, the hook still runs (the value applies in memory)
		const seen2: number[] = [];
		await openRelayMenu(r.ctx, { ...r.deps, settings: { ...r.settings, setUsageStatus: () => false } as any, onUsageStatus: () => seen2.push(1) });
		FakeList.last.onChange(MENU_IDS.usage, "off");
		assert.deepEqual(r.notes, [["Could not save the setting; it applies until Pi restarts.", "warning"]]);
		assert.deepEqual(seen2, [1]);
	} finally { r.done(); }
});

test("menu: 'Reset time in status bar' cycles always/near/never and 'Reset time format' full/compact, right after usage", () => {
	const r = rig();
	try {
		let items = menuItems(r.deps, truncate);
		const i = items.findIndex((x) => x.id === MENU_IDS.resetWhen);
		assert.deepEqual([items[i].label, items[i].currentValue, items[i].values], ["Reset time in status bar", "always", ["always", "near", "never"]]);
		assert.deepEqual([items[i + 1].id, items[i + 1].label, items[i + 1].currentValue, items[i + 1].values], [MENU_IDS.resetFormat, "Reset time format", "full", ["full", "compact"]]);
		assert.equal(items[i - 1].id, MENU_IDS.usage);
		r.settings.setResetWhen("never");
		r.settings.setResetFormat("compact");
		items = menuItems(r.deps, truncate);
		assert.deepEqual([items[i].currentValue, items[i + 1].currentValue], ["never", "compact"]);
	} finally { r.done(); }
});

test("applyMenuChange sets the reset when and format and persists them; values of another item are rejected", () => {
	const r = rig();
	try {
		assert.equal(applyMenuChange(MENU_IDS.resetWhen, "near", r.settings), true);
		assert.equal(applyMenuChange(MENU_IDS.resetFormat, "compact", r.settings), true);
		assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")), { status: { resetWhen: "near", resetFormat: "compact" } });
		assert.equal(applyMenuChange(MENU_IDS.resetWhen, "compact", r.settings), undefined);
		assert.equal(applyMenuChange(MENU_IDS.resetFormat, "never", r.settings), undefined);
		assert.equal(applyMenuChange(MENU_IDS.usage, "near", r.settings), undefined);
		const t = createSettings(r.file);
		assert.deepEqual([t.resetWhen(), t.resetFormat(), t.usageStatus()], ["near", "compact", true]);
	} finally { r.done(); }
});

test("openRelayMenu: changing either reset setting repaints the footer at once", async () => {
	const r = rig();
	try {
		const seen: string[] = [];
		await openRelayMenu(r.ctx, { ...r.deps, onUsageStatus: () => seen.push(`${r.settings.resetWhen()},${r.settings.resetFormat()}`) });
		FakeList.last.onChange(MENU_IDS.resetWhen, "near");
		FakeList.last.onChange(MENU_IDS.resetFormat, "compact");
		assert.deepEqual(seen, ["near,full", "near,compact"]);
	} finally { r.done(); }
});
