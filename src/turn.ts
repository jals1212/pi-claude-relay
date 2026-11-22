// Maps one Anthropic message (raw SSE events re-emitted by `claude -p --include-partial-messages`)
// to Pi assistant-message events. One Pi stream() call == one Anthropic message.
// No Pi runtime imports: the shapes mirror @earendil-works/pi-ai types structurally.

export interface TextBlock { type: "text"; text: string }
export interface ThinkingBlock { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; argumentsError?: string }
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface Usage {
	input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
	/** Part of `cacheWrite` written with the 1 h TTL (priced higher than 5 min writes). */
	cacheWrite1h?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface RelayMessage {
	role: "assistant";
	content: ContentBlock[];
	api: string; provider: string; model: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	rawStopReason?: string;
	responseId?: string;
	responseModel?: string;
	timestamp: number;
}

export type RelayEvent =
	| { type: "start"; partial: RelayMessage }
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; partial: RelayMessage }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string; partial: RelayMessage }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: RelayMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallBlock; partial: RelayMessage }
	| { type: "done"; reason: "stop" | "length" | "toolUse"; message: RelayMessage }
	| { type: "error"; reason: "aborted" | "error"; error: RelayMessage };

export interface TurnMapperInit {
	api: string; provider: string; model: string;
	/** Prefix Claude Code puts on MCP tool names, e.g. `mcp__pi__`; stripped from tool calls. */
	toolPrefix: string;
	/** Pi tool names offered to Claude. When given, a tool_use for any other name fails the turn. */
	toolNames?: readonly string[];
	emit: (event: RelayEvent) => void;
	now?: () => number;
	/** Fills `usage.cost` from the token counts (Pi's `calculateCost` for the request's model); called whenever the counts change. */
	applyCost?: (usage: Usage) => void;
}

export interface TurnMapper {
	readonly message: RelayMessage;
	readonly started: boolean;
	readonly finished: boolean;
	/** Feed one raw SSE event. Returns "done" once the turn has a terminal event. */
	handle(event: any): "continue" | "done";
	/** Terminate the turn with an error (no-op once finished). */
	fail(errorMessage: string, reason?: "error" | "aborted"): void;
}

/** The name claude gives an MCP tool: every character outside letters, digits, `_` and `-` becomes `_` (seen on Claude Code 2.1.330). */
export function claudeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Printable, single-line, at most 80 characters; `unknown` when there is nothing usable. */
function printableName(name: unknown): string {
	if (typeof name !== "string") return "unknown";
	const clean = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 80);
	return clean || "unknown";
}

const STOP_REASONS: Record<string, StopReason> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", refusal: "stop", max_tokens: "length", model_context_window_exceeded: "length", tool_use: "toolUse" };

/** Tool calls claude answers itself (unknown names) that one turn may drop; the next one fails the turn, so a model stuck on a made-up name cannot loop. */
export const MAX_SKIPPED_CALLS = 3;

export function createTurnMapper(init: TurnMapperInit): TurnMapper {
	const now = init.now ?? Date.now;
	const message: RelayMessage = {
		role: "assistant", content: [], api: init.api, provider: init.provider, model: init.model,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending", timestamp: now(),
	};
	let started = false;
	let finished = false;
	const byIndex = new Map<number, { contentIndex: number; json: string }>();
	/** Tool calls skipped in the current Anthropic message (see `claudeAnswersItself`). */
	let skipped = 0;
	/** Tool calls skipped in the whole turn, bounded by `MAX_SKIPPED_CALLS`. */
	let skippedInTurn = 0;
	/** Token counts of earlier Anthropic messages of this turn (a message that only held skipped calls is followed by another one). */
	const carried = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

	const ensureStarted = () => { if (!started) { started = true; init.emit({ type: "start", partial: message }); } };
	const applyUsage = (u: any) => {
		if (!u || typeof u !== "object") return;
		const set = (key: keyof typeof carried, v: unknown) => { if (typeof v === "number") message.usage[key] = carried[key] + v; };
		set("input", u.input_tokens); set("output", u.output_tokens);
		set("cacheRead", u.cache_read_input_tokens); set("cacheWrite", u.cache_creation_input_tokens);
		const longWrite = u.cache_creation?.ephemeral_1h_input_tokens;
		set("cacheWrite1h", longWrite);
		const x = message.usage; x.totalTokens = x.input + x.output + x.cacheRead + x.cacheWrite;
		try { init.applyCost?.(x); } catch { /* unknown rates must not break the turn: the cost stays as it was */ }
	};
	const offered = init.toolNames ? new Set(init.toolNames) : undefined;
	/** Offered names claude rewrites, by the rewritten name. A rewritten name two tools share (or that is another tool's own name) is left out: it is never guessed. */
	const rewritten = new Map<string, string>();
	if (offered) {
		const shared = new Set<string>();
		for (const n of offered) {
			const c = claudeToolName(n);
			if (c === n) continue;
			if (offered.has(c) || rewritten.has(c)) shared.add(c);
			rewritten.set(c, n);
		}
		for (const c of shared) rewritten.delete(c);
	}
	/** The Pi tool name for a tool_use, or undefined when Pi did not offer it (not prefixed, not a string, not in toolNames). */
	const piToolName = (name: unknown): string | undefined => {
		if (typeof name !== "string" || !name.startsWith(init.toolPrefix)) return undefined;
		const stripped = name.slice(init.toolPrefix.length);
		if (!stripped) return undefined;
		if (!offered || offered.has(stripped)) return stripped;
		return rewritten.get(stripped);
	};

	/** The names claude itself knows: the offered tools as its MCP server lists them. Without toolNames, every prefixed name. */
	const claudeKnown = offered ? new Set([...offered].map((n) => init.toolPrefix + claudeToolName(n))) : undefined;
	/**
	 * A name claude does not know: an offered tool called without the MCP prefix (the model copied it from Pi's prompt) or a name
	 * the model made up (`mcp__pi__notification`, a doubled prefix). claude answers the model with `No such tool available` itself
	 * and the model tries again in the same turn, so the call is dropped instead of failing the turn. It never reaches Pi.
	 * A name claude does know but Pi cannot map (a rewritten name two offered tools share) is not dropped: claude would run it.
	 */
	const claudeAnswersItself = (name: unknown): boolean =>
		typeof name === "string" && name !== "" && (claudeKnown ? !claudeKnown.has(name) : !name.startsWith(init.toolPrefix));

	function fail(errorMessage: string, reason: "error" | "aborted" = "error") {
		if (finished) return;
		finished = true;
		message.stopReason = reason;
		message.errorMessage = errorMessage;
		init.emit({ type: "error", reason, error: message });
	}

	/** Never throws: an event shape that breaks the mapper fails the turn instead. */
	function handle(ev: any): "continue" | "done" {
		try {
			return handleEvent(ev);
		} catch (e) {
			fail(`Malformed event from claude: ${printableName((e as Error)?.message)}`);
			return "done";
		}
	}

	function handleEvent(ev: any): "continue" | "done" {
		if (finished) return "done";
		switch (ev?.type) {
			case "message_start":
				ensureStarted();
				if (typeof ev.message?.id === "string") message.responseId = ev.message.id;
				// Claude Code labels its own synthetic error messages "<synthetic>"; that is not a model that answered.
				const answered = ev.message?.model;
				if (typeof answered === "string" && answered !== "<synthetic>") message.responseModel = answered;
				applyUsage(ev.message?.usage);
				break;
			case "content_block_start": {
				ensureStarted();
				const b = ev.content_block && typeof ev.content_block === "object" ? ev.content_block : {};
				const contentIndex = message.content.length;
				if (b.type === "text") {
					message.content.push({ type: "text", text: "" });
					init.emit({ type: "text_start", contentIndex, partial: message });
				} else if (b.type === "thinking" || b.type === "redacted_thinking") {
					const block: ThinkingBlock = b.type === "thinking" ? { type: "thinking", thinking: "" } : { type: "thinking", thinking: "", thinkingSignature: b.data, redacted: true };
					message.content.push(block);
					init.emit({ type: "thinking_start", contentIndex, partial: message });
				} else if (b.type === "tool_use") {
					const name = piToolName(b.name);
					if (name === undefined && claudeAnswersItself(b.name) && skippedInTurn < MAX_SKIPPED_CALLS) { skipped++; skippedInTurn++; break; }
					if (name === undefined) { fail(`Claude called a tool Pi did not offer: ${printableName(b.name)}`); return "done"; }
					if (typeof b.id !== "string" || !b.id) { fail(`Claude called a tool without an id: ${printableName(b.name)}`); return "done"; }
					message.content.push({ type: "toolCall", id: b.id, name, arguments: {} });
					init.emit({ type: "toolcall_start", contentIndex, partial: message });
				} else break;
				byIndex.set(ev.index, { contentIndex, json: "" });
				break;
			}
			case "content_block_delta": {
				const slot = byIndex.get(ev.index);
				if (!slot) break;
				const block = message.content[slot.contentIndex];
				const d = ev.delta && typeof ev.delta === "object" ? ev.delta : {};
				if (d.type === "text_delta" && block.type === "text" && typeof d.text === "string") {
					block.text += d.text;
					init.emit({ type: "text_delta", contentIndex: slot.contentIndex, delta: d.text, partial: message });
				} else if (d.type === "thinking_delta" && block.type === "thinking" && typeof d.thinking === "string") {
					block.thinking += d.thinking;
					init.emit({ type: "thinking_delta", contentIndex: slot.contentIndex, delta: d.thinking, partial: message });
				} else if (d.type === "signature_delta" && block.type === "thinking" && typeof d.signature === "string") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
				} else if (d.type === "input_json_delta" && block.type === "toolCall" && typeof d.partial_json === "string") {
					slot.json += d.partial_json;
					init.emit({ type: "toolcall_delta", contentIndex: slot.contentIndex, delta: d.partial_json, partial: message });
				}
				break;
			}
			case "content_block_stop": {
				const slot = byIndex.get(ev.index);
				if (!slot) break;
				byIndex.delete(ev.index);
				const block = message.content[slot.contentIndex];
				if (block.type === "text") init.emit({ type: "text_end", contentIndex: slot.contentIndex, content: block.text, partial: message });
				else if (block.type === "thinking") init.emit({ type: "thinking_end", contentIndex: slot.contentIndex, content: block.thinking, partial: message });
				else {
					if (slot.json.trim()) {
						try {
							const parsed = JSON.parse(slot.json);
							if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) block.arguments = parsed;
							else block.argumentsError = "Tool arguments JSON is not an object";
						} catch (e) {
							block.argumentsError = `Invalid tool arguments JSON: ${(e as Error).message}`;
						}
					}
					init.emit({ type: "toolcall_end", contentIndex: slot.contentIndex, toolCall: block, partial: message });
				}
				break;
			}
			case "message_delta":
				if (typeof ev.delta?.stop_reason === "string" && ev.delta.stop_reason) {
					message.rawStopReason = ev.delta.stop_reason;
					message.stopReason = Object.hasOwn(STOP_REASONS, ev.delta.stop_reason) ? STOP_REASONS[ev.delta.stop_reason] : "stop";
				}
				applyUsage(ev.usage);
				break;
			case "message_stop":
				ensureStarted();
				if (message.stopReason === "pending") { fail("Claude message ended without a stop reason"); return "done"; }
				if (skipped > 0) {
					skipped = 0;
					if (message.stopReason === "toolUse" && !message.content.some((c) => c.type === "toolCall")) {
						// Only skipped calls: claude answers them itself and the model's next message belongs to this same turn.
						for (const key of Object.keys(carried) as (keyof typeof carried)[]) carried[key] = message.usage[key] ?? 0;
						message.stopReason = "pending";
						message.rawStopReason = undefined;
						byIndex.clear();
						return "continue";
					}
				}
				finished = true;
				init.emit({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
				return "done";
		}
		return "continue";
	}

	return {
		get message() { return message; },
		get started() { return started; },
		get finished() { return finished; },
		handle, fail,
	};
}
