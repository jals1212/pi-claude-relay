// Footer status colors through Pi's theme. Text is built as segments so the plain string stays testable and
// identical to the uncolored footer; ANSI codes only ever come from Pi's own `theme.fg`.

/** Theme tokens the relay uses (all exist in Pi's `ThemeColor`). */
export type FooterColor = "success" | "warning" | "error" | "dim";
export interface Segment { text: string; color?: FooterColor }
export interface ThemeLike { fg(color: FooterColor, text: string): string }

export const plain = (segments: Segment[]): string => segments.map((s) => s.text).join("");

/** Same thresholds as Pi's own footer for context usage: > 90 % error, > 70 % warning. `fraction` is 0..1. */
export function utilizationColor(fraction: number): FooterColor {
	return fraction > 0.9 ? "error" : fraction > 0.7 ? "warning" : "success";
}

/** Colors the segments with `theme`; any problem (no theme, no `fg`, a throwing or non-string `fg`) yields the plain text. */
export function paint(segments: Segment[], theme?: ThemeLike): string {
	if (!theme || typeof theme.fg !== "function") return plain(segments);
	try {
		return segments.map((s) => {
			if (!s.color) return s.text;
			const out = theme.fg(s.color, s.text);
			if (typeof out !== "string") throw new TypeError("theme.fg returned a non-string");
			return out;
		}).join("");
	} catch {
		return plain(segments);
	}
}

/** Pi's theme from an extension context (`ctx.ui.theme`); undefined when unavailable or when reading it throws. */
export function themeOf(ctx: { ui?: { theme?: unknown } } | undefined): ThemeLike | undefined {
	try {
		const theme = ctx?.ui?.theme as ThemeLike | undefined;
		return theme && typeof theme.fg === "function" ? theme : undefined;
	} catch {
		return undefined;
	}
}
