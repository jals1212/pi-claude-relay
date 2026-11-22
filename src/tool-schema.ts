// Claude Code drops MCP tools whose inputSchema is not a plain top-level `{type:"object"}`
// (e.g. a top-level anyOf/oneOf/allOf). This flattens such schemas into a permissive object schema.
// Pi validates the arguments itself when it runs the tool, so being permissive here is safe.
// Only the top level is rewritten; nested schemas are left untouched.

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const KEPT_ROOT_KEYS = ["title", "description", "additionalProperties", "$defs", "definitions"] as const;

interface Shape { properties: Record<string, unknown>; required: string[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function mergeProperty(a: unknown, b: unknown): unknown {
	if (same(a, b)) return a;
	const list = (x: unknown) => (isObj(x) && Array.isArray(x.anyOf) && Object.keys(x).length === 1 ? (x.anyOf as unknown[]) : [x]);
	const anyOf = [...list(a)];
	for (const x of list(b)) if (!anyOf.some((y) => same(x, y))) anyOf.push(x);
	return { anyOf };
}

/** Union of the property maps; a property whose schemas differ becomes a nested anyOf. */
function unionProperties(maps: Record<string, unknown>[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = k in out ? mergeProperty(out[k], v) : v;
	return out;
}

/** Shape of any schema: own properties/required, merged allOf branches, union of anyOf/oneOf branches. */
function shapeOf(schema: unknown): Shape {
	if (!isObj(schema)) return { properties: {}, required: [] };
	const own: Shape = { properties: isObj(schema.properties) ? { ...schema.properties } : {}, required: stringList(schema.required) };
	let shape = own;
	const all = Array.isArray(schema.allOf) ? schema.allOf : [];
	for (const branch of all) {
		const b = shapeOf(branch);
		shape = { properties: unionProperties([shape.properties, b.properties]), required: [...new Set([...shape.required, ...b.required])] };
	}
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = Array.isArray(schema[key]) ? (schema[key] as unknown[]) : [];
		if (!branches.length) continue;
		const shapes = branches.map(shapeOf);
		const common = shapes.map((s) => s.required).reduce((acc, r) => acc.filter((x) => r.includes(x)));
		shape = {
			properties: unionProperties([shape.properties, ...shapes.map((s) => s.properties)]),
			required: [...new Set([...shape.required, ...common])],
		};
	}
	return shape;
}

export interface NormalizedSchema {
	inputSchema: Schema;
	/** Original schemas the permissive object stands for (anyOf/oneOf branches, or the unusable original). */
	variants?: unknown[];
}

export function normalizeToolSchema(schema: unknown): NormalizedSchema {
	if (!isObj(schema)) return { inputSchema: { type: "object", properties: {} } };
	const hasCombinator = COMBINATORS.some((k) => k in schema);
	if (schema.type === "object" && !hasCombinator) return { inputSchema: schema };
	if (schema.type !== undefined && schema.type !== "object") {
		return { inputSchema: { type: "object", properties: {} }, variants: [schema] };
	}
	const shape = shapeOf(schema);
	const inputSchema: Schema = { type: "object" };
	for (const k of KEPT_ROOT_KEYS) if (k in schema) inputSchema[k] = schema[k];
	inputSchema.properties = shape.properties;
	if (shape.required.length) inputSchema.required = shape.required;
	const variants = ["anyOf", "oneOf"].flatMap((k) => (Array.isArray(schema[k]) ? (schema[k] as unknown[]) : []));
	return variants.length ? { inputSchema, variants } : { inputSchema };
}

export function normalizeTool(tool: { name: string; description: string; parameters: unknown }): { name: string; description: string; inputSchema: Schema } {
	const { inputSchema, variants } = normalizeToolSchema(tool.parameters);
	const description = variants?.length
		? `${tool.description}\n\nArguments: the schema above is a permissive union. Provide the arguments of one of these argument shapes (checked when the tool runs):\n${variants.map((v) => `- ${JSON.stringify(v)}`).join("\n")}`
		: tool.description;
	return { name: tool.name, description, inputSchema };
}
