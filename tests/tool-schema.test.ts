import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTool, normalizeToolSchema } from "../src/tool-schema.ts";

const str = { type: "string" };
const num = { type: "number" };

test("plain object schema is returned unchanged", () => {
	const schema = { type: "object", properties: { path: str }, required: ["path"], additionalProperties: false };
	const out = normalizeToolSchema(schema);
	assert.deepEqual(out.inputSchema, schema);
	assert.equal(out.variants, undefined);
});

test("object schema with nested anyOf in a property is left untouched", () => {
	const schema = { type: "object", properties: { v: { anyOf: [str, num] } } };
	assert.deepEqual(normalizeToolSchema(schema).inputSchema, schema);
});

test("allOf of object branches is merged (properties union, required union)", () => {
	const out = normalizeToolSchema({
		description: "d",
		allOf: [
			{ type: "object", properties: { a: str }, required: ["a"] },
			{ type: "object", properties: { b: num }, required: ["b"] },
			{ type: "object", properties: { c: str } },
		],
	});
	assert.deepEqual(out.inputSchema, { type: "object", description: "d", properties: { a: str, b: num, c: str }, required: ["a", "b"] });
	assert.equal(out.variants, undefined, "allOf is exact, nothing to describe");
});

test("anyOf of object branches becomes a permissive union: all properties, required = intersection", () => {
	const v1 = { type: "object", properties: { id: str, name: str }, required: ["id", "name"] };
	const v2 = { type: "object", properties: { id: str, path: str }, required: ["id"] };
	const out = normalizeToolSchema({ anyOf: [v1, v2] });
	assert.deepEqual(out.inputSchema, { type: "object", properties: { id: str, name: str, path: str }, required: ["id"] });
	assert.deepEqual(out.variants, [v1, v2]);
});

test("oneOf behaves like anyOf; a property with different schemas per variant becomes a nested anyOf", () => {
	const v1 = { type: "object", properties: { v: str }, required: ["v"] };
	const v2 = { type: "object", properties: { v: num }, required: ["v"] };
	const out = normalizeToolSchema({ oneOf: [v1, v2] });
	assert.deepEqual(out.inputSchema, { type: "object", properties: { v: { anyOf: [str, num] } }, required: ["v"] });
	assert.deepEqual(out.variants, [v1, v2]);
});

test("own properties next to anyOf apply to every variant; $defs are kept", () => {
	const out = normalizeToolSchema({
		type: "object", properties: { base: str }, required: ["base"], $defs: { x: str },
		anyOf: [{ properties: { a: str }, required: ["a"] }, { properties: { b: str }, required: ["b"] }],
	});
	assert.deepEqual(out.inputSchema, { type: "object", $defs: { x: str }, properties: { base: str, a: str, b: str }, required: ["base"] });
});

test("a non-object variant makes every property optional", () => {
	const out = normalizeToolSchema({ anyOf: [{ type: "object", properties: { a: str }, required: ["a"] }, { type: "null" }] });
	assert.deepEqual(out.inputSchema, { type: "object", properties: { a: str } });
});

test("missing type with properties gets type object", () => {
	assert.deepEqual(normalizeToolSchema({ properties: { a: str }, required: ["a"] }).inputSchema, { type: "object", properties: { a: str }, required: ["a"] });
});

test("non-object top level (string, array, null, undefined) falls back to an empty object schema and is described", () => {
	for (const schema of [{ type: "string" }, { type: "array", items: str }, null, undefined, "x"]) {
		const out = normalizeToolSchema(schema);
		assert.deepEqual(out.inputSchema, { type: "object", properties: {} });
		assert.equal(out.variants?.length ?? 0, schema && typeof schema === "object" ? 1 : 0);
	}
});

test("normalizeTool keeps name and description for plain schemas", () => {
	const t = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: str } } };
	assert.deepEqual(normalizeTool(t), { name: "read", description: "Read a file", inputSchema: t.parameters });
});

test("normalizeTool describes the original variants in the description", () => {
	const v1 = { type: "object", properties: { a: str }, required: ["a"] };
	const v2 = { type: "object", properties: { b: str }, required: ["b"] };
	const out = normalizeTool({ name: "t", description: "Does things", parameters: { anyOf: [v1, v2] } });
	assert.equal(out.inputSchema.type, "object");
	assert.ok(out.description.startsWith("Does things\n\n"));
	assert.ok(out.description.includes(JSON.stringify(v1)));
	assert.ok(out.description.includes(JSON.stringify(v2)));
	assert.match(out.description, /one of these argument shapes/);
});
