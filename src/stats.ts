// Prompt-cache bookkeeping for one provider: how many turns, how many claude processes were started or lost, and how much
// of the input came from Anthropic's cache. Pure: no I/O, no Pi imports.
import type { TurnInfo } from "./session.ts";
import { timingSummaryLines, type TimingSummary } from "./timing.ts";

export type LastTurn = TurnInfo & { sessionKey: string };

export interface StatsSummary {
	turns: number;
	spawns: number;
	/** Restarts that continued claude's own session (`--resume`) instead of replaying a flattened transcript; a subset of `restarts.total`. */
	resumes: number;
	restarts: { total: number; byReason: Record<string, number> };
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** cacheRead / (input + cacheRead + cacheWrite); 0 when that sum is 0. */
	hitRate: number;
	/** Pi cache-warm requests answered locally. */
	warmRequests: number;
	/** Turns of throwaway sessions (compaction, summaries); kept out of the totals above. */
	throwawayTurns: number;
	last: LastTurn | undefined;
}

export interface Stats {
	record(sessionKey: string, info: TurnInfo, opts?: { throwaway?: boolean }): void;
	recordWarm(): void;
	summary(): StatsSummary;
}

export function createStats(): Stats {
	let turns = 0, spawns = 0, resumes = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, warmRequests = 0, throwawayTurns = 0;
	const byReason: Record<string, number> = {};
	let restartTotal = 0;
	let last: LastTurn | undefined;
	return {
		record(sessionKey, info, opts) {
			if (opts?.throwaway) { throwawayTurns++; return; }
			turns++;
			if (info.plan === "spawn") spawns++;
			else if (info.plan === "restart") {
				const reason = info.reason || "other";
				byReason[reason] = (byReason[reason] ?? 0) + 1;
				restartTotal++;
				if (info.resumed) resumes++;
			}
			if (info.usage) {
				input += info.usage.input; output += info.usage.output;
				cacheRead += info.usage.cacheRead; cacheWrite += info.usage.cacheWrite;
			}
			last = { sessionKey, ...info };
		},
		recordWarm() { warmRequests++; },
		summary() {
			const denominator = input + cacheRead + cacheWrite;
			return {
				turns, spawns, resumes, restarts: { total: restartTotal, byReason: { ...byReason } },
				input, output, cacheRead, cacheWrite, hitRate: denominator > 0 ? cacheRead / denominator : 0,
				warmRequests, throwawayTurns, last: last && { ...last },
			};
		},
	};
}

/** Latency timing as `/claude-relay stats` shows it: the switch and, while it is on, the summary of the timed requests. */
export interface LatencyView { on: boolean; summary?: TimingSummary }

/** The text of `/claude-relay stats`: the prompt-cache figures, then the latency block when `latency` is given. */
export function statsText(s: StatsSummary, latency?: LatencyView): string {
	const reasons = Object.entries(s.restarts.byReason)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([reason, n]) => `${reason} ${n}`);
	const restarts = `${s.restarts.total}${reasons.length ? ` (${reasons.join(", ")})` : ""}`;
	return [
		`Claude relay stats: ${s.turns} turns · cache hit ${Math.round(s.hitRate * 100)}%`,
		`process starts: ${s.spawns} · restarts: ${restarts}${s.resumes > 0 ? ` · resumed: ${s.resumes}` : ""}`,
		`cache warm requests answered locally: ${s.warmRequests} · one-off requests: ${s.throwawayTurns}`,
		...(latency ? latencyLines(latency) : []),
	].join("\n");
}

function latencyLines(l: LatencyView): string[] {
	if (!l.on) return ["latency timing: off (/claude-relay timing on records it)"];
	const lines = l.summary ? timingSummaryLines(l.summary) : [];
	return lines.length ? [`latency, ${lines[0]}`, ...lines.slice(1)] : ["latency timing: on, no timed requests yet"];
}
