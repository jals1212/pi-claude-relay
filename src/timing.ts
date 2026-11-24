// Opt-in latency timing (`/claude-relay timing on`). The session takes a few marks per request in memory (see `TurnTiming`);
// this module turns a settled turn into one JSON line (async append, never awaited) and keeps a small in-process sample for the summary
// that `/claude-relay stats` shows.
// Content-free: times, token counts, stop reason, model and the restart category only.
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { TurnReport } from "./provider.ts";
import type { TurnTiming } from "./session.ts";

/** Requests kept in memory for the summary; the oldest is dropped first. */
export const TIMING_SAMPLE_CAP = 500;

export interface TimingStat { n: number; median: number; p90: number }
export interface TimingSummary {
	requests: number;
	/** First line claude sent for the request. */
	firstEvent?: TimingStat;
	/** First thinking delta. */
	firstThinking?: TimingStat;
	/** First text delta or tool call, whichever came first: the first visible output. */
	firstOutput?: TimingStat;
	/** Request start to settle. */
	total?: TimingStat;
	/**
	 * Output tokens per second from the first generated token (thinking, text or tool call) to the stop (the settle when
	 * there is no stop mark): the model's generation speed without the spawn, the time to the first token or Pi's tool runs.
	 * Median and nearest-rank 10th percentile (the slow tail).
	 */
	outputRate?: RateStat;
}

export interface RateStat { n: number; median: number; p10: number }

/** Median (mean of the two middle values for an even count) and nearest-rank 90th percentile. `undefined` for an empty list. */
export function timingStat(values: number[]): TimingStat | undefined {
	if (!values.length) return undefined;
	const v = [...values].sort((a, b) => a - b);
	const mid = v.length >> 1;
	const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
	return { n: v.length, median, p90: v[Math.ceil(0.9 * v.length) - 1] };
}

export interface TimingDeps {
	/** The JSON lines file (`<agent home>/claude-relay-timing.jsonl`). */
	file: string;
	/** Read for every settled turn: a boolean check, nothing more, while timing is off. */
	enabled: () => boolean;
	max?: number;
	/** Test seam; defaults to `fs.promises.appendFile` with mode 0600. */
	append?: (file: string, line: string) => Promise<unknown>;
}

export interface Timing {
	readonly file: string;
	/** Called for every settled turn; does nothing unless timing is on and the turn carries marks. Never throws. */
	record(report: TurnReport): void;
	summary(): TimingSummary;
}

const round = (ms: number | undefined) => (typeof ms === "number" ? Math.round(ms * 10) / 10 : undefined);
const sha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
const defaultAppend = (file: string, line: string) => appendFile(file, line, { mode: 0o600 });

interface Sample { firstEvent?: number; firstThinking?: number; firstOutput?: number; total: number; outputRate?: number }

/** Tokens per second over [first generated token, stop or settle]; `undefined` without output, a generated token or a positive window. */
function outputRate(t: TurnTiming, output: number | undefined): number | undefined {
	const starts = [t.firstThinking, t.firstText, t.firstTool].filter((x): x is number => typeof x === "number");
	if (!output || output <= 0 || !starts.length) return undefined;
	const window = (t.stop ?? t.settle) - Math.min(...starts);
	return window > 0 ? output / (window / 1000) : undefined;
}

function rateStat(values: number[]): RateStat | undefined {
	const st = timingStat(values);
	if (!st) return undefined;
	const v = [...values].sort((a, b) => a - b);
	return { n: st.n, median: st.median, p10: v[Math.ceil(0.1 * v.length) - 1] };
}

export function createTiming(deps: TimingDeps): Timing {
	const max = deps.max ?? TIMING_SAMPLE_CAP;
	const samples: Sample[] = [];
	const append = deps.append ?? defaultAppend;
	return {
		file: deps.file,
		record(report) {
			try {
				const t: TurnTiming | undefined = report.info.timing;
				if (!t || !deps.enabled()) return;
				const { info } = report;
				// Compaction and summaries, and turns that ended in an error or abort, would skew the figures of a normal turn.
				if (!report.throwaway && (info.stopReason === "stop" || info.stopReason === "length" || info.stopReason === "toolUse")) {
					const outputs = [t.firstText, t.firstTool].filter((x): x is number => typeof x === "number");
					samples.push({ firstEvent: t.firstLine, firstThinking: t.firstThinking, firstOutput: outputs.length ? Math.min(...outputs) : undefined, total: t.settle, outputRate: outputRate(t, info.usage?.output) });
					if (samples.length > max) samples.splice(0, samples.length - max);
				}
				const line = {
					t: Date.now(), session: sha8(report.sessionKey), plan: info.plan, reason: info.reason, changed: info.changed, throwaway: report.throwaway || undefined,
					model: t.model, stopReason: info.stopReason, output: info.usage?.output,
					spawn: round(t.spawn), firstLine: round(t.firstLine), messageStart: round(t.messageStart), firstThinking: round(t.firstThinking),
					firstText: round(t.firstText), firstTool: round(t.firstTool), stop: round(t.stop), settle: round(t.settle),
				};
				// Fire and forget: the turn never waits for the disk and a write error is dropped.
				Promise.resolve(append(deps.file, JSON.stringify(line) + "\n")).catch(() => {});
			} catch { /* timing must never break a turn */ }
		},
		summary() {
			const pick = (f: (s: Sample) => number | undefined) => timingStat(samples.map(f).filter((x): x is number => typeof x === "number"));
			return { requests: samples.length, firstEvent: pick((s) => s.firstEvent), firstThinking: pick((s) => s.firstThinking), firstOutput: pick((s) => s.firstOutput), total: pick((s) => s.total), outputRate: rateStat(samples.map((s) => s.outputRate).filter((x): x is number => typeof x === "number")) };
		},
	};
}

const ms = (n: number) => String(Math.round(n));

/** The summary lines (empty when no request was sampled): milliseconds, median / p90. */
export function timingSummaryLines(s: TimingSummary): string[] {
	if (!s.requests) return [];
	const row = (label: string, st?: TimingStat) => st && `${label}: ${ms(st.median)} / ${ms(st.p90)} ms (n=${st.n})`;
	return [
		`last ${s.requests} request${s.requests === 1 ? "" : "s"} · median / p90`,
		row("first event", s.firstEvent), row("first thinking", s.firstThinking), row("first text or tool call", s.firstOutput), row("total", s.total),
		s.outputRate && `output rate: ${ms(s.outputRate.median)} tok/s median, ${ms(s.outputRate.p10)} slowest 10% (n=${s.outputRate.n})`,
	].filter((l): l is string => !!l);
}

/** The text of `/claude-relay timing`: the switch and the log file. The summary is part of `/claude-relay stats`. */
export function timingStateText(on: boolean, file: string | undefined): string {
	return `Claude relay timing: ${on ? `on${file ? ` (${file})` : ""}` : "off"}`;
}
