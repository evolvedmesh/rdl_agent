/**
 * A minimal MCP server over stdio.
 *
 * stdio is the only transport every ACP agent must support, so it is the path that has
 * to work. Written against the wire protocol directly rather than the SDK: the surface
 * we need is initialize / tools/list / tools/call, and a dependency-free server is one
 * less thing to vendor into a shipped binary later.
 *
 * Hard rule: stdout carries JSON-RPC and nothing else. All logging goes to stderr.
 */

export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type Tool = {
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

type Req = {
	jsonrpc: "2.0";
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
};

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function log(...args: unknown[]): void {
	process.stderr.write(`${args.map(String).join(" ")}\n`);
}

export class McpServer {
	#tools = new Map<string, Tool>();

	constructor(private readonly info: { name: string; version: string }) {}

	tool(t: Tool): this {
		this.#tools.set(t.name, t);
		return this;
	}

	tools(list: Tool[]): this {
		for (const t of list) this.tool(t);
		return this;
	}

	/** Exposed so the HTTP transport can share one dispatch path with stdio. */
	async handle(req: {
		id?: number | string;
		method: string;
		params?: Record<string, unknown>;
	}): Promise<unknown> {
		return this.#dispatch(req as never);
	}

	async serve(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";

		for await (const chunk of Bun.stdin.stream()) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
				if (!line) continue;
				// Sequential on purpose: a render is a live BC round trip, and interleaving
				// tool calls from one agent turn would defeat the per-connection queue.
				await this.#handleLine(line);
			}
		}
	}

	async #handleLine(line: string): Promise<void> {
		let req: Req;
		try {
			req = JSON.parse(line) as Req;
		} catch {
			this.#send({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			});
			return;
		}

		// Notifications have no id and take no reply.
		if (req.id === undefined || req.id === null) return;

		try {
			const result = await this.#dispatch(req);
			this.#send({ jsonrpc: "2.0", id: req.id, result });
		} catch (e) {
			this.#send({
				jsonrpc: "2.0",
				id: req.id,
				error: {
					code: -32603,
					message: e instanceof Error ? e.message : String(e),
				},
			});
		}
	}

	async #dispatch(req: Req): Promise<unknown> {
		switch (req.method) {
			case "initialize": {
				const asked = String(req.params?.protocolVersion ?? "");
				return {
					protocolVersion: SUPPORTED_PROTOCOLS.includes(asked)
						? asked
						: SUPPORTED_PROTOCOLS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: this.info,
				};
			}
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: [...this.#tools.values()].map((t) => ({
						name: t.name,
						title: t.title,
						description: t.description,
						inputSchema: t.inputSchema,
					})),
				};
			case "tools/call": {
				const name = String(req.params?.name ?? "");
				const tool = this.#tools.get(name);
				if (!tool) throw new Error(`Unknown tool: ${name}`);
				const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
				try {
					return await tool.handler(args);
				} catch (e) {
					// A tool failure is a result the model can act on, not a protocol error —
					// this is how BC's own message reaches the agent instead of a log line.
					return {
						content: [
							{
								type: "text",
								text: e instanceof Error ? e.message : String(e),
							},
						],
						isError: true,
					} satisfies ToolResult;
				}
			}
			default:
				throw Object.assign(new Error(`Method not found: ${req.method}`), {
					code: -32601,
				});
		}
	}

	#send(msg: unknown): void {
		process.stdout.write(`${JSON.stringify(msg)}\n`);
	}
}

export const text = (s: string): ToolResult => ({
	content: [{ type: "text", text: s }],
});
export const failure = (s: string): ToolResult => ({
	content: [{ type: "text", text: s }],
	isError: true,
});
