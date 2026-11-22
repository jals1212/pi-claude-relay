import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";

const tools = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

/** `id: null` sends a JSON-RPC notification (no id). */
async function rpc(host: McpHost, method: string, params?: unknown, id: number | null = 1, url = host.url) {
	const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }) });
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function withHost(fn: (host: McpHost) => Promise<void>) {
	const host = createMcpHost({ tools });
	await host.start();
	try { await fn(host); } finally { await host.close(); }
}

test("url is loopback with a random secret path; other paths get 404", async () => {
	await withHost(async (host) => {
		const u = new URL(host.url);
		assert.equal(u.hostname, "127.0.0.1");
		assert.match(u.pathname, /^\/[0-9a-f]{32}$/);
		const bad = await rpc(host, "tools/list", {}, 1, `${u.origin}/nope`);
		assert.equal(bad.status, 404);
		const get = await fetch(host.url);
		assert.equal(get.status, 405);
		await get.text();
	});
});

test("initialize, notifications and tools/list follow MCP", async () => {
	await withHost(async (host) => {
		const init = await rpc(host, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		assert.equal(init.status, 200);
		assert.equal(init.body.result.protocolVersion, "2025-06-18");
		assert.deepEqual(init.body.result.capabilities, { tools: {} });
		const note = await rpc(host, "notifications/initialized", undefined, null);
		assert.equal(note.status, 202);
		const list = await rpc(host, "tools/list", {});
		assert.deepEqual(list.body.result.tools, [
			{ name: "read", description: "Read a file", inputSchema: tools[0].parameters },
			{ name: "bash", description: "Run a command", inputSchema: tools[1].parameters },
		]);
		const unknown = await rpc(host, "server/discover", {});
		assert.equal(unknown.body.error.code, -32601);
	});
});

test("a tool call stays parked until Pi resolves the matching tool call id", async () => {
	await withHost(async (host) => {
		host.expect({ id: "toolu_1", name: "read", arguments: { path: "a.ts" } });
		let settled = false;
		const call = rpc(host, "tools/call", { name: "read", arguments: { path: "a.ts" } }, 7).then((r) => { settled = true; return r; });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(settled, false);
		assert.deepEqual(host.pendingIds(), ["toolu_1"]);
		host.resolve("toolu_1", { content: [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
		const r = await call;
		assert.equal(r.body.id, 7);
		assert.deepEqual(r.body.result, { content: [{ type: "text", text: "hello" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
		assert.deepEqual(host.pendingIds(), []);
	});
});

test("result arriving before the MCP call is answered immediately; isError is kept", async () => {
	await withHost(async (host) => {
		host.expect({ id: "t1", name: "bash", arguments: { command: "false" } });
		host.resolve("t1", { content: [{ type: "text", text: "exit 1" }], isError: true });
		const r = await rpc(host, "tools/call", { name: "bash", arguments: { command: "false" } });
		assert.deepEqual(r.body.result, { content: [{ type: "text", text: "exit 1" }], isError: true });
	});
});

test("parallel calls of the same tool match by arguments, regardless of arrival order", async () => {
	await withHost(async (host) => {
		host.expect({ id: "a", name: "read", arguments: { path: "1" } });
		host.expect({ id: "b", name: "read", arguments: { path: "2" } });
		const second = rpc(host, "tools/call", { name: "read", arguments: { path: "2" } }, 2);
		const first = rpc(host, "tools/call", { name: "read", arguments: { path: "1" } }, 1);
		await new Promise((r) => setTimeout(r, 30));
		host.resolve("a", { content: [{ type: "text", text: "one" }], isError: false });
		host.resolve("b", { content: [{ type: "text", text: "two" }], isError: false });
		assert.equal((await first).body.result.content[0].text, "one");
		assert.equal((await second).body.result.content[0].text, "two");
	});
});

test("_meta claudecode/toolUseId pairs exactly, even when arguments differ or repeat", async () => {
	await withHost(async (host) => {
		host.expect({ id: "toolu_A", name: "read", arguments: { path: "same" } });
		host.expect({ id: "toolu_B", name: "read", arguments: { path: "same" } });
		const b = rpc(host, "tools/call", { name: "read", arguments: { path: "same", extra: 1 }, _meta: { "claudecode/toolUseId": "toolu_B" } }, 2);
		const a = rpc(host, "tools/call", { name: "read", arguments: { path: "same" }, _meta: { "claudecode/toolUseId": "toolu_A" } }, 1);
		await new Promise((r) => setTimeout(r, 30));
		host.resolve("toolu_B", { content: [{ type: "text", text: "B" }], isError: false });
		host.resolve("toolu_A", { content: [{ type: "text", text: "A" }], isError: false });
		assert.equal((await a).body.result.content[0].text, "A");
		assert.equal((await b).body.result.content[0].text, "B");
		const unknown = await rpc(host, "tools/call", { name: "read", arguments: { path: "same" }, _meta: { "claudecode/toolUseId": "toolu_Z" } });
		assert.equal(unknown.body.result.isError, true);
	});
});

test("key order in arguments does not break matching", async () => {
	await withHost(async (host) => {
		host.expect({ id: "x", name: "bash", arguments: { command: "ls", timeout: 5 } });
		const call = rpc(host, "tools/call", { name: "bash", arguments: { timeout: 5, command: "ls" } });
		await new Promise((r) => setTimeout(r, 20));
		host.resolve("x", { content: [{ type: "text", text: "ok" }], isError: false });
		assert.equal((await call).body.result.content[0].text, "ok");
	});
});

test("an unexpected tool call (no Pi tool call) returns an MCP error result at once", async () => {
	await withHost(async (host) => {
		const r = await rpc(host, "tools/call", { name: "read", arguments: { path: "zzz" } });
		assert.equal(r.body.result.isError, true);
		assert.match(r.body.result.content[0].text, /not requested/);
	});
});

test("failAll answers every parked call with an error and clears pending state", async () => {
	await withHost(async (host) => {
		host.expect({ id: "p", name: "read", arguments: { path: "a" } });
		const call = rpc(host, "tools/call", { name: "read", arguments: { path: "a" } });
		await new Promise((r) => setTimeout(r, 20));
		host.failAll("Request was aborted");
		const r = await call;
		assert.deepEqual(r.body.result, { content: [{ type: "text", text: "Request was aborted" }], isError: true });
		assert.deepEqual(host.pendingIds(), []);
	});
});

test("parked calls survive longer than Node's default request timeout settings", async () => {
	await withHost(async (host) => {
		assert.equal(host.server.requestTimeout, 0);
		assert.equal(host.server.timeout, 0);
	});
});

test("two hosts are independent (S2)", async () => {
	const a = createMcpHost({ tools });
	const b = createMcpHost({ tools: [tools[1]] });
	await Promise.all([a.start(), b.start()]);
	try {
		assert.notEqual(a.url, b.url);
		a.expect({ id: "same", name: "bash", arguments: { command: "a" } });
		b.expect({ id: "same", name: "bash", arguments: { command: "b" } });
		const ca = rpc(a, "tools/call", { name: "bash", arguments: { command: "a" } });
		const cb = rpc(b, "tools/call", { name: "bash", arguments: { command: "b" } });
		await new Promise((r) => setTimeout(r, 20));
		b.resolve("same", { content: [{ type: "text", text: "B" }], isError: false });
		a.resolve("same", { content: [{ type: "text", text: "A" }], isError: false });
		assert.equal((await ca).body.result.content[0].text, "A");
		assert.equal((await cb).body.result.content[0].text, "B");
		assert.equal((await rpc(b, "tools/list", {})).body.result.tools.length, 1);
	} finally { await Promise.all([a.close(), b.close()]); }
});

test("tools/list normalizes top-level anyOf/oneOf/allOf schemas to a plain object schema (Claude Code drops the others)", async () => {
	const v1 = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
	const v2 = { type: "object", properties: { b: { type: "string" } }, required: ["b"] };
	const host = createMcpHost({ tools: [
		{ name: "u", description: "Union", parameters: { anyOf: [v1, v2] } },
		{ name: "m", description: "Merged", parameters: { allOf: [v1, v2] } },
		{ name: "p", description: "Plain", parameters: v1 },
	] });
	await host.start();
	try {
		const { body } = await rpc(host, "tools/list", {});
		const [u, m, p] = body.result.tools;
		assert.deepEqual(u.inputSchema, { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
		assert.match(u.description, /^Union\n\n/);
		assert.ok(u.description.includes(JSON.stringify(v1)) && u.description.includes(JSON.stringify(v2)));
		assert.deepEqual(m, { name: "m", description: "Merged", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] } });
		assert.deepEqual(p, { name: "p", description: "Plain", inputSchema: v1 });
	} finally { await host.close(); }
});

// ---- input hardening (T12 / S8) ----

import http from "node:http";

/** Raw request so tests control Host, Origin and body framing (fetch cannot set Host). */
function raw(host: McpHost, opts: { headers?: Record<string, string>; body?: string | Buffer | Buffer[]; path?: string; method?: string } = {}) {
	const u = new URL(host.url);
	return new Promise<{ status: number; text: string }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port: u.port, path: opts.path ?? u.pathname, method: opts.method ?? "POST", headers: { "content-type": "application/json", ...opts.headers }, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", reject);
		});
		req.on("error", reject);
		const body = opts.body;
		if (Array.isArray(body)) { for (const b of body) req.write(b); req.end(); } else req.end(body);
	});
}

const stillServes = async (host: McpHost) => assert.equal((await rpc(host, "ping", {})).status, 200);

test("a non-object, null or invalid JSON body gets a JSON-RPC error (400) and the server keeps running", async () => {
	await withHost(async (host) => {
		const cases: [string, number][] = [["not json{", -32700], ["", -32700], ["null", -32600], ["42", -32600], ['"x"', -32600], ["[]", -32600], ["[1,2]", -32600]];
		for (const [body, code] of cases) {
			const res = await raw(host, { body });
			assert.equal(res.status, 400, body);
			assert.deepEqual(JSON.parse(res.text), { jsonrpc: "2.0", id: null, error: { code, message: JSON.parse(res.text).error.message } }, body);
			assert.equal(typeof JSON.parse(res.text).error.message, "string");
		}
		await stillServes(host);
	});
});

test("a request whose method is not a string is an invalid request, not a crash", async () => {
	await withHost(async (host) => {
		const res = await raw(host, { body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: { x: 1 } }) });
		assert.equal(res.status, 400);
		assert.equal(JSON.parse(res.text).error.code, -32600);
		await stillServes(host);
	});
});

test("a client that disconnects mid-body is swallowed and the server keeps running", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (e: unknown) => unhandled.push(e);
	process.on("uncaughtException", onUnhandled);
	process.on("unhandledRejection", onUnhandled);
	try {
		await withHost(async (host) => {
			const u = new URL(host.url);
			for (let i = 0; i < 3; i++) {
				await new Promise<void>((resolve) => {
					const req = http.request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "POST", headers: { "content-length": "1000" }, agent: false });
					req.on("error", () => resolve());
					req.on("close", () => resolve());
					req.write('{"jsonrpc":"2.0","id":1,');
					setTimeout(() => req.destroy(), 20);
				});
			}
			await new Promise((r) => setTimeout(r, 50));
			await stillServes(host);
		});
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("uncaughtException", onUnhandled);
		process.off("unhandledRejection", onUnhandled);
	}
});

test("bodies above 32 MiB are rejected with 413 and the server keeps running", async () => {
	await withHost(async (host) => {
		// content-length known up front: refused without waiting for the body
		const u = new URL(host.url);
		const declared = await new Promise<number>((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "POST", headers: { "content-length": String(32 * 1024 * 1024 + 1) }, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
			req.on("error", reject);
			req.write("{");
		});
		assert.equal(declared, 413);
		// chunked: no content-length, the cap is enforced while reading
		const chunks = Array.from({ length: 33 }, () => Buffer.alloc(1024 * 1024, 0x20));
		const chunked = await raw(host, { body: chunks, headers: { "transfer-encoding": "chunked" } }).catch((e: NodeJS.ErrnoException) => ({ status: 0, text: e.code ?? "" }));
		assert.ok(chunked.status === 413 || ["ECONNRESET", "EPIPE"].includes(chunked.text), `chunked: ${chunked.status} ${chunked.text}`);
		await stillServes(host);
		// a body of exactly 32 MiB of JSON whitespace + a valid request is still accepted
		const ok = Buffer.concat([Buffer.alloc(32 * 1024 * 1024 - 40, 0x20), Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')]);
		assert.ok(ok.length <= 32 * 1024 * 1024);
		assert.equal((await raw(host, { body: ok })).status, 200);
	});
});

test("multibyte characters split across body chunks survive", async () => {
	await withHost(async (host) => {
		host.expect({ id: "m", name: "bash", arguments: { command: "echo ñ€😀" } });
		host.resolve("m", { content: [{ type: "text", text: "ok" }], isError: false });
		const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bash", arguments: { command: "echo ñ€😀" } } }));
		const at = body.indexOf(Buffer.from("€")) + 1; // inside the 3-byte €
		const res = await raw(host, { body: [body.subarray(0, at), body.subarray(at)] });
		assert.equal(res.status, 200);
		assert.equal(JSON.parse(res.text).result.content[0].text, "ok");
	});
});

test("requests with a foreign Host or any Origin header get 403 before the body is read", async () => {
	await withHost(async (host) => {
		const port = new URL(host.url).port;
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		assert.equal((await raw(host, { body, headers: { host: `127.0.0.1:${port}` } })).status, 200);
		assert.equal((await raw(host, { body, headers: { host: `localhost:${port}` } })).status, 200);
		for (const h of [`evil.example:${port}`, "127.0.0.1", `127.0.0.1:${Number(port) + 1}`, `localhost.evil.example:${port}`, `[::1]:${port}`]) {
			const res = await raw(host, { body, headers: { host: h } });
			assert.equal(res.status, 403, h);
		}
		for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${port}`]) {
			assert.equal((await raw(host, { body, headers: { origin } })).status, 403, origin);
		}
		// rejected before reading the body: a request that never sends its declared body still gets answered
		const u = new URL(host.url);
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: u.port, path: u.pathname, method: "POST", headers: { origin: "http://evil.example", "content-length": "100" }, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
			req.on("error", reject);
			req.write("{");
		}).catch(() => -1);
		assert.equal(status, 403);
		await stillServes(host);
	});
});

test("a wrong token of the same or a different length is a 404", async () => {
	await withHost(async (host) => {
		const u = new URL(host.url);
		for (const path of [`/${"0".repeat(32)}`, `/${"0".repeat(5)}`, `${u.pathname}0`, `${u.pathname}?x=1`, "/"]) {
			assert.equal((await raw(host, { path, body: "{}" })).status, 404, path);
		}
	});
});

test("a handler failure answers with a JSON-RPC internal error instead of crashing", async () => {
	const host = createMcpHost({ tools: [{ name: "bad", description: "d", get parameters(): unknown { throw new Error("boom"); } } as any] });
	await host.start();
	try {
		const res = await raw(host, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
		assert.equal(res.status, 500);
		assert.equal(JSON.parse(res.text).error.code, -32603);
		assert.equal((await rpc(host, "ping", {})).status, 200);
	} finally { await host.close(); }
});

test("a parked call whose client gave up is no longer pending, so the session can restart instead of waiting for it", async () => {
	await withHost(async (host) => {
		host.expect({ type: "toolCall", id: "toolu_drop", name: "read", arguments: { path: "a" } });
		assert.deepEqual(host.pendingIds(), ["toolu_drop"], "expected but not yet called: still pending");
		const controller = new AbortController();
		const call = fetch(host.url, { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": "toolu_drop" } } }) }).catch(() => undefined);
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(host.pendingIds(), ["toolu_drop"], "parked with a live client");
		controller.abort();
		await call;
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(host.pendingIds(), []);
	});
});

const parkedCall = (host: McpHost, rpcId: number, toolUseId: string, signal?: AbortSignal) =>
	fetch(host.url, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": toolUseId } } }) }).catch(() => undefined);
const settleIo = () => new Promise((r) => setTimeout(r, 100));

test("claude closing a parked call reports the drop with the Pi tool call id", async () => {
	await withHost(async (host) => {
		const drops: string[] = [];
		host.onDrop((id) => drops.push(id));
		host.expect({ type: "toolCall", id: "toolu_drop", name: "read", arguments: { path: "a" } });
		const controller = new AbortController();
		const call = parkedCall(host, 7, "toolu_drop", controller.signal);
		await settleIo();
		assert.deepEqual(drops, []);
		controller.abort();
		await call;
		await settleIo();
		assert.deepEqual(drops, ["toolu_drop"]);
		assert.deepEqual(host.pendingIds(), []);
	});
});

test("notifications/cancelled for a parked call drops it (202, no reply); another request id changes nothing", async () => {
	await withHost(async (host) => {
		const drops: string[] = [];
		host.onDrop((id) => drops.push(id));
		host.expect({ type: "toolCall", id: "toolu_a", name: "read", arguments: { path: "a" } });
		const call = parkedCall(host, 7, "toolu_a");
		await settleIo();
		const other = await rpc(host, "notifications/cancelled", { requestId: 8, reason: "x" }, null);
		assert.equal(other.status, 202);
		assert.deepEqual([drops, host.pendingIds()], [[], ["toolu_a"]]);
		const cancel = await rpc(host, "notifications/cancelled", { requestId: 7, reason: "MCP tool call timed out" }, null);
		assert.equal(cancel.status, 202);
		assert.equal(cancel.body, undefined);
		assert.deepEqual([drops, host.pendingIds()], [["toolu_a"], []]);
		host.resolve("toolu_a", { content: [{ type: "text", text: "late" }], isError: false });
		assert.deepEqual(drops, ["toolu_a"], "a late result reports nothing more");
		void call;
	});
});

test("answered or failed calls never report a drop, even when the connection closes afterwards", async () => {
	await withHost(async (host) => {
		const drops: string[] = [];
		host.onDrop((id) => drops.push(id));
		host.expect({ type: "toolCall", id: "toolu_ok", name: "read", arguments: { path: "a" } });
		host.expect({ type: "toolCall", id: "toolu_fail", name: "bash", arguments: { command: "x" } });
		const ok = parkedCall(host, 1, "toolu_ok");
		const fail = fetch(host.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bash", arguments: { command: "x" }, _meta: { "claudecode/toolUseId": "toolu_fail" } } }) });
		await settleIo();
		host.resolve("toolu_ok", { content: [{ type: "text", text: "done" }], isError: false });
		const okRes = await ok;
		assert.equal((await okRes!.json()).result.content[0].text, "done");
		host.failAll("Request was aborted");
		assert.equal((await (await fail).json()).result.isError, true);
		await settleIo();
		assert.deepEqual(drops, []);
	});
});
