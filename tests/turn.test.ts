import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnMapper, MAX_SKIPPED_CALLS, type RelayEvent } from "../src/turn.ts";

function harness() {
	const events: RelayEvent[] = [];
	const mapper = createTurnMapper({ api: "anthropic-messages", provider: "anthropic", model: "sonnet", toolPrefix: "mcp__pi__", now: () => 1000, emit: (e) => events.push(structuredClone(e)) });
	return { events, mapper, types: () => events.map((e) => e.type) };
}

const start = (usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }) => ({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage } });

test("text turn maps to start/text_*/done stop with usage", () => {
	const { events, mapper, types } = harness();
	for (const e of [
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hola" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " mundo" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
	]) assert.equal(mapper.handle(e), "continue");
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.equal(done.reason, "stop");
	assert.deepEqual(done.message.content, [{ type: "text", text: "Hola mundo" }]);
	assert.equal(done.message.responseId, "msg_1");
	assert.deepEqual(done.message.usage, { input: 3, output: 7, cacheRead: 100, cacheWrite: 20, totalTokens: 130, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
	assert.equal((events[2] as any).delta, "Hola");
	assert.equal((events[4] as any).content, "Hola mundo");
});

test("tool_use maps to toolCall with stripped prefix, parsed arguments and toolUse stop", () => {
	const { events, mapper, types } = harness();
	for (const e of [
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__pi__read", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\": \"a" } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ".ts\"}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
	]) mapper.handle(e);
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_delta", "toolcall_end", "done"]);
	const end = events[5] as Extract<RelayEvent, { type: "toolcall_end" }>;
	assert.deepEqual(end.toolCall, { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } });
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content, [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } }]);
});

test("tool_use with empty input yields {} and malformed JSON yields argumentsError", () => {
	const { events, mapper } = harness();
	for (const e of [
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__pi__ls", input: {} } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t2", name: "mcp__pi__bash", input: {} } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\": " } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" } },
		{ type: "message_stop" },
	]) mapper.handle(e);
	const ends = events.filter((e) => e.type === "toolcall_end") as Extract<RelayEvent, { type: "toolcall_end" }>[];
	assert.deepEqual(ends[0].toolCall, { type: "toolCall", id: "t1", name: "ls", arguments: {} });
	assert.equal(ends[1].toolCall.name, "bash");
	assert.deepEqual(ends[1].toolCall.arguments, {});
	assert.match(ends[1].toolCall.argumentsError ?? "", /JSON/i);
});

test("thinking blocks keep text and signature", () => {
	const { events, mapper, types } = harness();
	for (const e of [
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pienso" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig==" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" } },
		{ type: "message_stop" },
	]) mapper.handle(e);
	assert.deepEqual(types(), ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.deepEqual(done.message.content, [{ type: "thinking", thinking: "pienso", thinkingSignature: "sig==" }, { type: "text", text: "ok" }]);
});

test("max_tokens maps to length; partial message_delta usage keeps message_start values", () => {
	const { events, mapper } = harness();
	for (const e of [start(), { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 50, input_tokens: null } }, { type: "message_stop" }]) mapper.handle(e);
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.equal(done.reason, "length");
	assert.equal(done.message.usage.input, 3);
	assert.equal(done.message.usage.output, 50);
});

test("fail before any event emits a single error with stopReason error and no start", () => {
	const { events, mapper, types } = harness();
	mapper.fail("claude exited with code 1");
	mapper.fail("second call is ignored");
	assert.deepEqual(types(), ["error"]);
	const err = events[0] as Extract<RelayEvent, { type: "error" }>;
	assert.equal(err.reason, "error");
	assert.equal(err.error.stopReason, "error");
	assert.equal(err.error.errorMessage, "claude exited with code 1");
	assert.equal(mapper.finished, true);
});

test("abort mid-stream emits aborted error after start; later events are ignored", () => {
	const { events, mapper, types } = harness();
	mapper.handle(start());
	mapper.handle({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } });
	mapper.fail("Request was aborted", "aborted");
	assert.equal(mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } }), "done");
	assert.deepEqual(types(), ["start", "text_start", "text_delta", "error"]);
	const err = events.at(-1) as Extract<RelayEvent, { type: "error" }>;
	assert.equal(err.reason, "aborted");
	assert.equal(err.error.stopReason, "aborted");
	assert.deepEqual(err.error.content, [{ type: "text", text: "a" }]);
});

test("message_stop without a stop reason is an error, not done", () => {
	const { events, mapper } = harness();
	mapper.handle(start());
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.equal(events.at(-1)!.type, "error");
	assert.match((events.at(-1) as any).error.errorMessage, /stop reason/);
});

test("responseModel is set on the final message; a synthetic model name is not recorded", () => {
	const run = (model: string) => {
		const events: any[] = [];
		const m = createTurnMapper({ api: "a", provider: "p", model: "claude-sonnet-5-5", toolPrefix: "mcp__pi__", emit: (e) => events.push(e) });
		for (const ev of [{ type: "message_start", message: { id: "x", model, usage: {} } }, { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]) m.handle(ev);
		return events.at(-1);
	};
	assert.equal(run("claude-sonnet-5-5-20260101").message.responseModel, "claude-sonnet-5-5-20260101");
	assert.equal(run("<synthetic>").message.responseModel, undefined);
});

// ---- malformed / unoffered tool_use (T12 / S8) ----

function strict(toolNames?: string[]) {
	const events: RelayEvent[] = [];
	const mapper = createTurnMapper({ api: "a", provider: "p", model: "m", toolPrefix: "mcp__pi__", toolNames, now: () => 1, emit: (e) => events.push(structuredClone(e)) });
	return { events, mapper, types: () => events.map((e) => e.type) };
}
const toolStart = (block: unknown, index = 0) => ({ type: "content_block_start", index, content_block: block });

test("a tool_use with a name claude does not know is skipped and never emitted as a tool call", () => {
	const cases: [string[] | undefined, string][] = [
		[undefined, "Bash"], [["read"], "Bash"], [["read"], "mcp__pi__rm_rf"], [["read"], "mcp__pi__notification"],
		[["read", "subagent_parent_message"], "mcp__pi__mcp__pi__subagent_parent_message"],
	];
	for (const [toolNames, name] of cases) {
		const { events, mapper, types } = strict(toolNames);
		mapper.handle(start());
		assert.equal(mapper.handle(toolStart({ type: "tool_use", id: "t1", name, input: {} })), "continue", name);
		assert.equal(mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }), "continue");
		assert.equal(mapper.handle({ type: "content_block_stop", index: 0 }), "continue");
		assert.deepEqual(types(), ["start"], name);
		assert.equal(mapper.finished, false);
		assert.deepEqual(mapper.message.content, []);
	}
});

test(`call ${MAX_SKIPPED_CALLS + 1} with an unknown name fails the turn, across messages, so a model stuck on a made-up name cannot loop`, () => {
	const { events, mapper, types } = strict(["read"]);
	for (let i = 0; i < MAX_SKIPPED_CALLS; i++) {
		for (const e of bareCall(`msg_${i}`, i % 2 ? "read" : "mcp__pi__notification")) assert.equal(mapper.handle(e), "continue");
		assert.equal(mapper.handle({ type: "message_stop" }), "continue");
	}
	assert.deepEqual(types(), ["start"]);
	mapper.handle({ type: "message_start", message: { id: "msg_last", usage: {} } });
	assert.equal(mapper.handle(toolStart({ type: "tool_use", id: "t_last", name: "mcp__pi__notification", input: {} })), "done");
	assert.deepEqual(types(), ["start", "error"]);
	const err = events.at(-1) as Extract<RelayEvent, { type: "error" }>;
	assert.equal(err.reason, "error");
	assert.equal(err.error.stopReason, "error");
	assert.equal(err.error.errorMessage, "Claude called a tool Pi did not offer: mcp__pi__notification");
	assert.deepEqual(err.error.content, []);
	assert.equal(mapper.finished, true);
	// later events of the dead turn are ignored
	assert.equal(mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }), "done");
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "error"]);
});

test("a message holding only skipped calls that ends with end_turn completes the turn with no tool call", () => {
	const { events, mapper, types } = strict(["read"]);
	mapper.handle(start());
	mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__notification", input: {} }));
	mapper.handle({ type: "content_block_stop", index: 0 });
	mapper.handle({ type: "message_delta", delta: { stop_reason: "end_turn" } });
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "done"]);
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.equal(done.reason, "stop");
	assert.deepEqual(done.message.content, []);
});

test("without toolNames, the bare prefix alone is not skipped: it fails the turn", () => {
	const { events, mapper } = strict();
	mapper.handle(start());
	assert.equal(mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__", input: {} })), "done");
	assert.equal((events.at(-1) as any).error.errorMessage, "Claude called a tool Pi did not offer: mcp__pi__");
	assert.equal(events.some((e) => e.type === "toolcall_start"), false);
});

test("the skip limit is per turn: a new turn may skip again", () => {
	for (let t = 0; t < 2; t++) {
		const { mapper, types } = strict(["read"]);
		for (let i = 0; i < MAX_SKIPPED_CALLS; i++) assert.equal(mapper.handle(toolStart({ type: "tool_use", id: `s${i}`, name: "Bash", input: {} }, i)), "continue");
		assert.deepEqual(types(), ["start"]);
	}
});

test("a tool_use without a string name fails the turn as unknown, without throwing", () => {
	for (const name of [undefined, null, 5, {}, ["x"]]) {
		const { events, mapper } = strict();
		assert.doesNotThrow(() => mapper.handle(toolStart({ type: "tool_use", id: "t1", name, input: {} })));
		const err = events.at(-1) as Extract<RelayEvent, { type: "error" }>;
		assert.equal(err.type, "error");
		assert.equal(err.error.errorMessage, "Claude called a tool Pi did not offer: unknown");
		assert.equal(events.some((e) => e.type === "toolcall_start"), false);
	}
});

test("with toolNames, a prefixed tool Pi did not offer is skipped, never a tool call; offered tools still map", () => {
	const bad = strict(["read"]);
	assert.equal(bad.mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__rm_rf", input: {} })), "continue");
	assert.deepEqual(bad.types(), ["start"]);
	assert.equal(bad.mapper.finished, false);

	const ok = strict(["read"]);
	ok.mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__read", input: {} }));
	assert.deepEqual(ok.types(), ["start", "toolcall_start"]);
	assert.equal((ok.events[1] as any).partial.content[0].name, "read");
});

test("the tool name in the error is printable and at most 80 characters", () => {
	const { events, mapper } = strict(["read"]);
	for (let i = 0; i < MAX_SKIPPED_CALLS; i++) mapper.handle(toolStart({ type: "tool_use", id: `s${i}`, name: "Bash", input: {} }, i));
	mapper.handle(toolStart({ type: "tool_use", id: "t1", name: `ev\u0000il\n\u001b[31m${"x".repeat(200)}`, input: {} }));
	const msg = (events.at(-1) as any).error.errorMessage as string;
	const name = msg.replace("Claude called a tool Pi did not offer: ", "");
	assert.ok(name.length <= 80 && name.length > 0, name);
	assert.doesNotMatch(name, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
	assert.ok(name.startsWith("evil"));
});

test("a tool_use without a string id fails the turn instead of emitting a broken tool call", () => {
	const { events, mapper } = strict();
	mapper.handle(toolStart({ type: "tool_use", name: "mcp__pi__read", input: {} }));
	assert.equal(events.at(-1)!.type, "error");
	assert.equal(events.some((e) => e.type === "toolcall_start"), false);
});

test("malformed events never throw: missing content_block/delta, odd indexes, wrong field types", () => {
	const { events, mapper } = strict(["read"]);
	const junk: unknown[] = [
		undefined, null, 5, "x", [], {}, { type: 5 },
		{ type: "message_start" }, { type: "message_start", message: null }, { type: "message_start", message: { id: 7, model: {}, usage: "x" } },
		{ type: "content_block_start" }, { type: "content_block_start", index: 0, content_block: null }, { type: "content_block_start", index: 0, content_block: "text" },
		{ type: "content_block_delta" }, { type: "content_block_delta", index: 99, delta: { type: "text_delta", text: "x" } }, { type: "content_block_delta", index: -1 },
		{ type: "content_block_stop" }, { type: "content_block_stop", index: 99 },
		{ type: "message_delta" }, { type: "message_delta", delta: null, usage: null }, { type: "message_delta", delta: { stop_reason: "constructor" } },
	];
	for (const ev of junk) assert.doesNotThrow(() => mapper.handle(ev), JSON.stringify(ev));
	// wrong-typed deltas on live blocks
	mapper.handle({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	mapper.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 5 } });
	mapper.handle({ type: "content_block_delta", index: 0, delta: null });
	mapper.handle({ type: "content_block_stop", index: 0 });
	assert.doesNotThrow(() => mapper.handle({ type: "message_stop" }));
	const last = events.at(-1) as any;
	assert.ok(last.type === "done" || last.type === "error");
	if (last.type === "done") assert.equal(["stop", "length", "toolUse"].includes(last.message.stopReason), true);
	const text = (last.type === "done" ? last.message : last.error).content.find((b: any) => b.type === "text");
	if (text) assert.equal(text.text.includes("undefined") || text.text.includes("5"), false);
});

test("the cost callback prices the final usage, including 1 h cache writes", () => {
	const events: RelayEvent[] = [];
	const seen: any[] = [];
	const mapper = createTurnMapper({ api: "anthropic-messages", provider: "anthropic", model: "sonnet", toolPrefix: "mcp__pi__", now: () => 1000, emit: (e) => events.push(structuredClone(e)),
		applyCost: (u: any) => { seen.push(structuredClone(u)); u.cost.total = u.input + u.output + u.cacheRead + u.cacheWrite; } });
	mapper.handle({ type: "message_start", message: { id: "m", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 15, ephemeral_5m_input_tokens: 5 } } } });
	mapper.handle({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	mapper.handle({ type: "content_block_stop", index: 0 });
	mapper.handle({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
	mapper.handle({ type: "message_stop" });
	const usage = (events.at(-1) as any).message.usage;
	assert.equal(usage.cacheWrite1h, 15);
	assert.equal(usage.cost.total, 3 + 7 + 100 + 20, "priced on the final token counts");
	assert.equal(seen.at(-1).output, 7);
});

test("a throwing cost callback never breaks the turn", () => {
	const events: RelayEvent[] = [];
	const mapper = createTurnMapper({ api: "a", provider: "p", model: "m", toolPrefix: "mcp__pi__", emit: (e) => events.push(e), applyCost: () => { throw new Error("no rates"); } });
	mapper.handle(start());
	mapper.handle({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.equal((events.at(-1) as any).message.usage.cost.total, 0);
});

const bareCall = (id: string, name: string) => [
	{ type: "message_start", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } },
	toolStart({ type: "tool_use", id: "toolu_bare", name, input: {} }),
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"x\":1}" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
];

test("an offered tool called without the prefix is skipped: claude answers it itself and the turn continues with its next message", () => {
	const { events, mapper, types } = strict(["read", "subagent_run"]);
	for (const e of bareCall("msg_1", "subagent_run")) assert.equal(mapper.handle(e), "continue");
	assert.equal(mapper.handle({ type: "message_stop" }), "continue");
	assert.equal(mapper.finished, false);
	assert.deepEqual(types(), ["start"]);
	for (const e of [
		{ type: "message_start", message: { id: "msg_2", model: "claude-sonnet-5-5", usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 } } },
		toolStart({ type: "tool_use", id: "toolu_2", name: "mcp__pi__subagent_run", input: {} }),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } },
	]) assert.equal(mapper.handle(e), "continue");
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "toolcall_start", "toolcall_end", "done"]);
	const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
	assert.equal(done.reason, "toolUse");
	assert.deepEqual(done.message.content, [{ type: "toolCall", id: "toolu_2", name: "subagent_run", arguments: {} }]);
	assert.equal(done.message.responseId, "msg_2");
	// both Anthropic messages were billed: their usage adds up
	assert.deepEqual({ ...done.message.usage, cost: undefined }, { input: 30, output: 10, cacheRead: 300, cacheWrite: 5, totalTokens: 345, cost: undefined });
});

test("a skipped bare call next to a real tool call ends the message normally with only the real call", () => {
	const { events, mapper, types } = strict(["read"]);
	mapper.handle(start());
	mapper.handle(toolStart({ type: "tool_use", id: "t_bare", name: "read", input: {} }, 0));
	mapper.handle({ type: "content_block_stop", index: 0 });
	mapper.handle(toolStart({ type: "tool_use", id: "t_ok", name: "mcp__pi__read", input: {} }, 1));
	mapper.handle({ type: "content_block_stop", index: 1 });
	mapper.handle({ type: "message_delta", delta: { stop_reason: "tool_use" } });
	assert.equal(mapper.handle({ type: "message_stop" }), "done");
	assert.deepEqual(types(), ["start", "toolcall_start", "toolcall_end", "done"]);
	assert.deepEqual((events.at(-1) as any).message.content, [{ type: "toolCall", id: "t_ok", name: "read", arguments: {} }]);
});

test("an unknown name alone in a message is skipped like a bare offered name: claude's next message completes the turn", () => {
	for (const name of ["Bash", "mcp__pi__parameter_placeholder"]) {
		const { events, mapper, types } = strict(["read"]);
		for (const e of bareCall("msg_1", name)) assert.equal(mapper.handle(e), "continue");
		assert.equal(mapper.handle({ type: "message_stop" }), "continue");
		for (const e of [
			{ type: "message_start", message: { id: "msg_2", usage: {} } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
		]) assert.equal(mapper.handle(e), "continue");
		assert.equal(mapper.handle({ type: "message_stop" }), "done");
		assert.deepEqual(types(), ["start", "done"], name);
		const done = events.at(-1) as Extract<RelayEvent, { type: "done" }>;
		assert.equal(done.reason, "stop");
		assert.deepEqual(done.message.content, []);
		assert.equal(done.message.responseId, "msg_2");
	}
});

test("a tool whose name claude rewrites (characters outside letters, digits, _ and -) maps back to Pi's own name", () => {
	for (const [piName, claudeName] of [["weird.name-x", "weird_name-x"], ["sp ace", "sp_ace"], ["ñandú", "_and_"]]) {
		const { events, mapper, types } = strict(["read", piName]);
		mapper.handle(start());
		mapper.handle(toolStart({ type: "tool_use", id: "t1", name: `mcp__pi__${claudeName}`, input: {} }));
		assert.deepEqual(types(), ["start", "toolcall_start"], piName);
		assert.equal((events[1] as any).partial.content[0].name, piName);
	}
});

test("a rewritten name that two offered tools share is not guessed: the turn fails; an exact name still wins", () => {
	const bad = strict(["a.b", "a b"]);
	bad.mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__a_b", input: {} }));
	assert.equal((bad.events.at(-1) as any).error.errorMessage, "Claude called a tool Pi did not offer: mcp__pi__a_b");
	assert.equal(bad.events.some((e) => e.type === "toolcall_start"), false);

	const exact = strict(["a.b", "a_b"]);
	exact.mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "mcp__pi__a_b", input: {} }));
	assert.equal((exact.events.at(-1) as any).partial.content[0].name, "a_b");
});

test("a rewritten name called without the prefix is skipped like any bare offered name", () => {
	const { mapper, types } = strict(["a.b"]);
	mapper.handle(start());
	assert.equal(mapper.handle(toolStart({ type: "tool_use", id: "t1", name: "a_b", input: {} })), "continue");
	assert.deepEqual(types(), ["start"]);
	assert.equal(mapper.finished, false);
});

test("two offered tools that share a rewritten name are still reachable by their exact names", () => {
	for (const name of ["a.b", "a b"]) {
		const { events, mapper } = strict(["a.b", "a b"]);
		mapper.handle(toolStart({ type: "tool_use", id: "t1", name: `mcp__pi__${name}`, input: {} }));
		assert.equal((events.at(-1) as any).partial.content[0].name, name);
	}
});
