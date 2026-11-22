// Decides how a Pi stream() request maps onto the live `claude` process:
// deliver tool results, send one new user message, or restart and replay the history.
import { StringDecoder } from "node:string_decoder";
import { canonicalJson } from "./mcp-host.ts";

export type PiContent = { type: string; [k: string]: any };
export type PiMessage =
	| { role: "user"; content: string | PiContent[]; timestamp: number }
	| { role: "assistant"; content: PiContent[]; responseId?: string; timestamp: number; [k: string]: any }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: PiContent[]; isError: boolean; timestamp: number };

export interface SessionConfig { model: string; systemPrompt: string; toolsKey: string; effort: string; /** sha256 of the credential: a changed login restarts claude, the raw token is never kept. */ credentialKey: string }

/** What the live claude process already knows. */
export interface Snapshot { config: SessionConfig; fingerprints: string[]; pendingToolCallIds: string[] }

export type RestartInput = { kind: "user"; message: Extract<PiMessage, { role: "user" }> } | { kind: "continue" };
export type Plan =
	| { kind: "send"; message: Extract<PiMessage, { role: "user" }> }
	| { kind: "resolve"; results: Extract<PiMessage, { role: "toolResult" }>[]; then: Extract<PiMessage, { role: "user" }> | undefined }
	| RestartPlan;

/**
 * Start a new claude process. `replay` + `input` are the flattened-transcript way (always present, also the fallback).
 * `resume` is set when claude's own session can carry the history instead: Pi's history has not diverged from the snapshot,
 * no tool call is pending in claude and the system prompt is unchanged; it is the one new user message to send on the resumed process.
 */
export interface RestartPlan { kind: "restart"; replay: PiMessage[]; input: RestartInput; reason: string; resume?: Extract<PiMessage, { role: "user" }> }

export function fingerprint(m: PiMessage): string {
	if (m.role === "assistant") return `a:${m.responseId ?? canonicalJson(m.content)}`;
	if (m.role === "toolResult") return `r:${m.toolCallId}:${m.isError ? 1 : 0}:${canonicalJson(m.content)}`;
	return `u:${canonicalJson(m.content)}`;
}

/** Config fields in the order they are reported; `label` is the text in the restart reason. */
const CONFIG_FIELDS: { key: keyof SessionConfig; label: string; category: string }[] = [
	{ key: "model", label: "model", category: "model" },
	{ key: "systemPrompt", label: "system prompt", category: "system-prompt" },
	{ key: "toolsKey", label: "tools", category: "tools" },
	{ key: "effort", label: "effort", category: "effort" },
	{ key: "credentialKey", label: "credential", category: "credential" },
];

const CONFIG_CHANGED = "config changed: ";

/** Restart reason for a config change: names every field that changed (`config changed: model, effort`). Empty when nothing changed. */
function configChange(a: SessionConfig, b: SessionConfig): string {
	const changed = CONFIG_FIELDS.filter((f) => a[f.key] !== b[f.key]).map((f) => f.label);
	return changed.length ? CONFIG_CHANGED + changed.join(", ") : "";
}

export type RestartCategory = "model" | "system-prompt" | "tools" | "effort" | "credential" | "history" | "missing-tool-call" | "other";

/** Short stable category of a planner restart reason, for stats and the debug log. A config change reports its first changed field (model, system prompt, tools, effort, credential). */
export function restartCategory(reason: string): RestartCategory {
	if (reason.startsWith(CONFIG_CHANGED)) {
		const first = reason.slice(CONFIG_CHANGED.length).split(", ")[0];
		return (CONFIG_FIELDS.find((f) => f.label === first)?.category ?? "other") as RestartCategory;
	}
	if (reason === "history diverged") return "history";
	if (reason === "tool results do not match pending tool calls") return "missing-tool-call";
	return "other";
}

/** The flattened-replay restart of `messages`; `resume` marks it resumable (see `RestartPlan`). */
export function restartPlan(messages: PiMessage[], reason: string, resume?: Extract<PiMessage, { role: "user" }>): RestartPlan {
	const last = messages.at(-1);
	const plan: RestartPlan = last?.role === "user"
		? { kind: "restart", replay: messages.slice(0, -1), input: { kind: "user", message: last }, reason }
		: { kind: "restart", replay: messages, input: { kind: "continue" }, reason };
	if (resume) plan.resume = resume;
	return plan;
}

/** Pi keeps the assistant message of an aborted turn in its context (pi-agent-core `agent-loop.js`); claude never saw it as an answer. */
const isAborted = (m: PiMessage) => m.role === "assistant" && m.stopReason === "aborted";

type UserMessage = Extract<PiMessage, { role: "user" }>;
const asBlocks = (content: string | PiContent[]): PiContent[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);

/**
 * Consecutive user messages as the one user line claude receives, or undefined when another role is among them.
 * Pi turns each extension notice into its own user message and often adds two at once (a result and its wake-up notice):
 * sending them together keeps the live claude session, and its prompt cache, instead of replaying the whole history.
 */
function mergeUsers(messages: PiMessage[]): UserMessage | undefined {
	if (messages.length === 0 || messages.some((m) => m.role !== "user")) return undefined;
	const users = messages as UserMessage[];
	if (users.length === 1) return users[0];
	return { role: "user", content: users.flatMap((m) => asBlocks(m.content)), timestamp: users.at(-1)!.timestamp };
}

/**
 * Whether the live claude session (the snapshot) can continue with `messages`: a `send` / `resolve` plan, or the reason it cannot.
 * Aborted assistant messages between the snapshot and the new input are skipped.
 */
function continuation(prev: Snapshot, messages: PiMessage[]): Plan | string {
	const known = prev.fingerprints;
	if (messages.length < known.length || known.some((f, i) => fingerprint(messages[i]) !== f)) return "history diverged";
	const tail = messages.slice(known.length);
	if (tail.length === 0) return "nothing new to send";
	const live = tail.filter((m) => !isAborted(m));
	if (live.length === 0) return "nothing new to send";

	if (prev.pendingToolCallIds.length === 0) {
		const message = mergeUsers(live);
		return message ? { kind: "send", message } : "unexpected messages after a finished turn";
	}

	const results = [] as Extract<PiMessage, { role: "toolResult" }>[];
	let i = 0;
	for (; i < live.length && live[i].role === "toolResult"; i++) results.push(live[i] as Extract<PiMessage, { role: "toolResult" }>);
	const rest = live.slice(i);
	const ids = new Set(results.map((x) => x.toolCallId));
	const covers = prev.pendingToolCallIds.length === ids.size && prev.pendingToolCallIds.every((id) => ids.has(id));
	if (!covers) return "tool results do not match pending tool calls";
	if (rest.length === 0) return { kind: "resolve", results, then: undefined };
	const then = mergeUsers(rest);
	return then ? { kind: "resolve", results, then } : "unexpected messages after tool results";
}

export function planTurn(prev: Snapshot | undefined, next: { config: SessionConfig; messages: PiMessage[] }): Plan {
	const { messages } = next;
	if (!prev) return restartPlan(messages, "new session");
	const changed = configChange(prev.config, next.config);
	const cont = continuation(prev, messages);
	if (changed) {
		// claude keeps the system prompt it was started with when a session is resumed, so a changed prompt needs the flattened replay.
		const resumable = typeof cont !== "string" && cont.kind === "send" && prev.config.systemPrompt === next.config.systemPrompt;
		return restartPlan(messages, changed, resumable ? (cont as Extract<Plan, { kind: "send" }>).message : undefined);
	}
	return typeof cont === "string" ? restartPlan(messages, cont) : cont;
}

export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * NDJSON reader: feed raw chunks, receive parsed objects. A single line is capped at `maxLineBytes`
 * (default 64 MiB): an oversized line is dropped (never buffered past the cap) and reported once through `onError`.
 * Only the new chunk is scanned for a newline, so a long line costs linear time.
 */
export function createLineReader(onValue: (value: any) => void, onBadLine: (line: string) => void = () => {}, onError?: (message: string) => void, maxLineBytes = MAX_LINE_BYTES) {
	const decoder = new StringDecoder("utf8");
	let pending: string[] = [];
	let pendingBytes = 0;
	let skipping = false; // inside an oversized line: discard until its newline
	const tooLong = () => onError?.(`Line longer than ${maxLineBytes} bytes dropped`);
	const emit = (line: string) => {
		if (!line.trim()) return;
		let value: unknown;
		try { value = JSON.parse(line); } catch { onBadLine(line); return; }
		onValue(value);
	};
	return (chunk: string | Buffer) => {
		let rest = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let nl: number;
		while ((nl = rest.indexOf("\n")) >= 0) {
			const head = rest.slice(0, nl);
			rest = rest.slice(nl + 1);
			if (skipping) { skipping = false; continue; }
			const total = pendingBytes + Buffer.byteLength(head);
			if (total > maxLineBytes) { pending = []; pendingBytes = 0; tooLong(); continue; }
			const line = pending.length ? pending.join("") + head : head;
			pending = []; pendingBytes = 0;
			emit(line);
		}
		if (!rest || skipping) return;
		pendingBytes += Buffer.byteLength(rest);
		if (pendingBytes > maxLineBytes) { pending = []; pendingBytes = 0; skipping = true; tooLong(); return; }
		pending.push(rest);
	};
}

/** Anything that looks like one of the replay envelope tags (opening or closing, any case). */
const ENVELOPE_TAG = /<(?=\s*\/?\s*(?:conversation_history|user|assistant|tool_call|tool_result)(?:[\s>/]|$))/gi;

/** Untrusted text can never open or close the envelope: the `<` of an envelope-looking tag becomes `&lt;`. Everything else is untouched. */
const esc = (text: string) => text.replace(ENVELOPE_TAG, "&lt;");
/** Attribute values additionally cannot end the attribute. */
const escAttr = (text: string) => esc(String(text)).replace(/"/g, "&quot;");

const textOf = (content: string | PiContent[]) =>
	typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");

/** Text replay of earlier turns for a fresh claude process. Thinking is dropped. */
export function renderTranscript(messages: PiMessage[]): string {
	const out = ["<conversation_history>"];
	for (const m of messages) {
		if (m.role === "user") out.push(`<user>\n${esc(textOf(m.content))}\n</user>`);
		else if (m.role === "toolResult") out.push(`<tool_result id="${escAttr(m.toolCallId)}" name="${escAttr(m.toolName)}"${m.isError ? ' error="true"' : ""}>\n${esc(textOf(m.content))}\n</tool_result>`);
		else {
			const parts = m.content.flatMap((c) =>
				c.type === "text" ? [esc(String(c.text))] : c.type === "toolCall" ? [`<tool_call id="${escAttr(c.id)}" name="${escAttr(c.name)}">${esc(JSON.stringify(c.arguments) ?? "{}")}</tool_call>`] : []);
			out.push(`<assistant>\n${parts.join("\n")}\n</assistant>`);
		}
	}
	out.push("</conversation_history>");
	return out.join("\n");
}
