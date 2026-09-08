/**
 * The stdio MCP shim, as a function.
 *
 * stdio is the only transport every ACP agent must support, but the tools need the
 * *running* app's render engine — the user should be looking at the same PDF the agent is
 * reasoning about, not a second copy from a second engine. So this is a thin proxy:
 * JSON-RPC in on stdin, HTTP to the app's localhost port, JSON-RPC back out on stdout.
 *
 * The agent spawns it as a subprocess. In dev that is `bun <main> mcp-shim --stdio
 * --session <id>`; in a compiled build it is `<app-binary> mcp-shim --stdio --session
 * <id>` — the entrypoint routes both here. Either way `LAYOUT_APP_PORT` must be in the
 * environment.
 *
 * Hard rule, same as any MCP server: stdout carries JSON-RPC and nothing else.
 */

/**
 * Run the shim to completion (resolves when stdin closes). On a usage error it prints to
 * stderr and calls `process.exit(2)` rather than returning — the agent treats a shim that
 * exits at startup as a hard failure, which is what a missing `--session` or port is.
 */
export async function runStdioShim(
	argv: string[] = process.argv.slice(2),
): Promise<void> {
	const sessionIdx = argv.indexOf("--session");
	const sessionId = sessionIdx === -1 ? undefined : argv[sessionIdx + 1];
	const port = process.env.LAYOUT_APP_PORT;
	const token = process.env.LAYOUT_APP_TOKEN;

	if (!sessionId) {
		process.stderr.write("usage: mcp-shim --stdio --session <sessionId>\n");
		process.exit(2);
	}
	if (!port) {
		process.stderr.write(
			"LAYOUT_APP_PORT is not set; the shim cannot reach the app.\n",
		);
		process.exit(2);
	}

	const endpoint = `http://127.0.0.1:${port}/mcp/${sessionId}`;
	const send = (msg: unknown) =>
		process.stdout.write(`${JSON.stringify(msg)}\n`);

	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk as Uint8Array, { stream: true });
		let nl: number;
		while (true) {
			nl = buffer.indexOf("\n");
			if (nl === -1) break;

			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;

			let msg: { id?: number | string };
			try {
				msg = JSON.parse(line) as { id?: number | string };
			} catch {
				send({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				});
				continue;
			}

			try {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: line,
				});
				// Notifications get a 202 with no body and take no reply.
				if (res.status === 202) continue;
				send(await res.json());
			} catch (e) {
				// The app going away mid-session must surface as a tool error, not a silent hang.
				if (msg.id !== undefined && msg.id !== null) {
					send({
						jsonrpc: "2.0",
						id: msg.id,
						error: {
							code: -32603,
							message: `Cannot reach the layout app on port ${port}: ${e}`,
						},
					});
				}
			}
		}
	}
}
