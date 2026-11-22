// Per-session MCP server (Streamable HTTP, JSON responses) that exposes Pi tools to `claude`.
// A `tools/call` is parked: the HTTP response stays open until Pi delivers the tool result
// for the matching Pi tool call. Pairing uses the `_meta["claudecode/toolUseId"]` Claude Code sends;
// name + canonical arguments (first in, first out) is only a fallback when that id is absent.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { normalizeTool } from "./tool-schema.ts";

export interface PiTool { name: string; description: string; parameters: unknown }
export interface ExpectedCall { id: string; name: string; arguments: Record<string, unknown> }
export type ResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult { content: ResultBlock[]; isError: boolean }

export interface McpHost {
	readonly url: string;
	readonly server: http.Server;
	start(): Promise<void>;
	close(): Promise<void>;
	/** Register a Pi tool call Claude is about to make through MCP. */
	expect(call: ExpectedCall): void;
	/** Deliver Pi's tool result for a tool call id. */
	resolve(id: string, result: ToolResult): void;
	/** Answer every parked or expected call with an error and forget them. */
	failAll(message: string): void;
	/** Ids of expected calls that have no delivered result yet. */
	pendingIds(): string[];
	/**
	 * Called with the Pi tool call id when claude gives up on a parked call (it closed the request or sent
	 * `notifications/cancelled`): claude has moved on without the result, so it can no longer receive it.
	 */
	onDrop(cb: (id: string) => void): void;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

type Reply = (result: unknown) => void;

/** `dropped`: claude called the tool and then gave up on the request, so nobody is waiting for its result any more. */
interface Entry { call: ExpectedCall; key: string; reply?: Reply; rpcId?: string | number; result?: ToolResult; dropped?: boolean }

/** JSON with sorted object keys, so argument key order does not matter. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const toMcpContent = (blocks: ResultBlock[]) =>
	blocks.map((b) => (b.type === "image" ? { type: "image", data: b.data, mimeType: b.mimeType } : { type: "text", text: b.text }));

export function createMcpHost(opts: { tools: PiTool[] }): McpHost {
	const token = randomBytes(16).toString("hex");
	const entries: Entry[] = []; // in Pi tool-call order
	let url = "";
	let dropListener: ((id: string) => void) | undefined;

	/** claude stopped waiting for this parked call: nobody can receive its result any more. */
	function drop(entry: Entry) {
		if (!entry.reply) return;
		entry.reply = undefined;
		entry.rpcId = undefined;
		entry.dropped = true;
		try { dropListener?.(entry.call.id); } catch { /* a listener must not break the server */ }
	}

	const keyOf = (name: string, args: unknown) => `${name}\u0000${canonicalJson(args ?? {})}`;

	function answer(entry: Entry) {
		if (!entry.reply || !entry.result) return;
		entry.reply({ content: toMcpContent(entry.result.content), isError: entry.result.isError });
		entries.splice(entries.indexOf(entry), 1);
	}

	function onToolCall(params: any, rpcId: string | number, reply: Reply) {
		const toolUseId = params?._meta?.["claudecode/toolUseId"];
		const key = keyOf(params?.name, params?.arguments);
		const entry = typeof toolUseId === "string"
			? entries.find((e) => !e.reply && e.call.id === toolUseId)
			: entries.find((e) => !e.reply && e.key === key);
		if (!entry) {
			reply({ content: [{ type: "text", text: `Tool call ${params?.name} was not requested by Pi; it was not run.` }], isError: true });
			return;
		}
		entry.reply = reply;
		entry.rpcId = rpcId;
		entry.dropped = false;
		answer(entry);
	}

	const isTokenPath = (path: string | undefined) => {
		const given = Buffer.from(path ?? "");
		const expected = Buffer.from(`/${token}`);
		return given.length === expected.length && timingSafeEqual(given, expected);
	};

	/** Only the literal loopback names with our own port; anything else (DNS rebinding) is refused. */
	const hostAllowed = (hostHeader: string | undefined) => {
		const port = (server.address() as AddressInfo | null)?.port;
		return port !== undefined && (hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`);
	};

	/** Collects the body as Buffers and decodes once. Resolves "aborted" when the client goes away, "too-large" above the cap. */
	const readBody = (req: http.IncomingMessage) => new Promise<{ text: string } | "aborted" | "too-large">((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const settle = (v: { text: string } | "aborted" | "too-large") => { if (!settled) { settled = true; resolve(v); } };
		req.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			size += buf.length;
			if (size > MAX_BODY_BYTES) { chunks.length = 0; settle("too-large"); return; }
			chunks.push(buf);
		});
		req.on("end", () => settle({ text: Buffer.concat(chunks).toString("utf8") }));
		req.on("error", () => settle("aborted"));
		req.on("aborted", () => settle("aborted"));
		req.on("close", () => settle("aborted"));
	});

	const rpcError = (res: http.ServerResponse, status: number, id: unknown, code: number, message: string) => {
		if (res.headersSent || res.writableEnded || res.destroyed) return;
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
	};

	async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
		req.on("error", () => {});
		res.on("error", () => {});
		if (!hostAllowed(req.headers.host) || req.headers.origin !== undefined) { res.writeHead(403, { connection: "close" }).end(); return; }
		if (!isTokenPath(req.url)) { res.writeHead(404).end(); return; }
		if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
		const declared = Number(req.headers["content-length"]);
		const tooLarge = () => { res.writeHead(413, { connection: "close" }).end(() => req.destroy()); };
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { tooLarge(); return; }
		const body = await readBody(req);
		if (body === "aborted") return;
		if (body === "too-large") { tooLarge(); return; }
		let msg: any;
		try { msg = JSON.parse(body.text); } catch { rpcError(res, 400, null, -32700, "Parse error"); return; }
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) { rpcError(res, 400, null, -32600, "Invalid Request: expected a JSON-RPC request object"); return; }
		if (msg.id === undefined || msg.id === null) {
			if (msg.method === "notifications/cancelled") {
				const requestId = msg.params?.requestId;
				const e = entries.find((x) => x.reply && x.rpcId !== undefined && x.rpcId === requestId);
				if (e) drop(e);
			}
			res.writeHead(202).end();
			return;
		}
		if (typeof msg.id !== "string" && typeof msg.id !== "number") { rpcError(res, 400, null, -32600, "Invalid Request: bad id"); return; }
		if (typeof msg.method !== "string") { rpcError(res, 400, msg.id, -32600, "Invalid Request: method must be a string"); return; }
		let done = false;
		const send = (payload: object) => {
			if (done) return;
			done = true;
			if (res.destroyed || res.writableEnded) return;
			try {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...payload }));
			} catch { /* the client is gone; nothing to answer */ }
		};
		switch (msg.method) {
			case "initialize":
				return send({ result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi", version: "1.0.0" } } });
			case "ping":
				return send({ result: {} });
			case "tools/list":
				return send({ result: { tools: opts.tools.map(normalizeTool) } });
			case "tools/call": {
				const reply: Reply = (result) => send({ result });
				res.on("close", () => {
					// Client gave up: forget the reply so a later result is kept for a retry, and stop reporting the call as pending
					// (a session that waited for it would hang forever).
					if (!done) { const e = entries.find((x) => x.reply === reply); if (e) drop(e); }
				});
				return onToolCall(msg.params, msg.id, reply);
			}
			default:
				return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
		}
	}

	// The handler never throws or rejects: a failure becomes a JSON-RPC error (or a closed socket) and the server keeps running.
	const server = http.createServer((req, res) => {
		handle(req, res).catch(() => {
			try {
				if (!res.headersSent) rpcError(res, 500, null, -32603, "Internal error");
				else res.destroy();
			} catch { /* nothing left to do */ }
		});
	});
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.timeout = 0;
	server.keepAliveTimeout = 60_000;

	return {
		get url() { return url; },
		server,
		async start() {
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
			url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
		},
		async close() {
			this.failAll("Claude relay session closed");
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
		expect(call) {
			entries.push({ call, key: keyOf(call.name, call.arguments) });
		},
		resolve(id, result) {
			const entry = entries.find((e) => e.call.id === id && !e.result);
			if (!entry) return;
			entry.result = result;
			answer(entry);
		},
		failAll(message) {
			for (const e of entries.splice(0)) e.reply?.({ content: [{ type: "text", text: message }], isError: true });
		},
		pendingIds() {
			return entries.filter((e) => !e.result && !e.dropped).map((e) => e.call.id);
		},
		onDrop(cb) {
			dropListener = cb;
		},
	};
}
