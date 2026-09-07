/**
 * MCP over localhost HTTP.
 *
 * Same dispatch as stdio — only the framing differs. Used when the provider advertises
 * `mcpCapabilities.http`, which lets the agent talk to the *running app's* engine
 * instead of spawning a second one. Agents that only speak stdio get the shim binary,
 * which proxies here.
 */
import type { McpServer } from "./server.ts";

/**
 * `servers` is a function, not a `Map`, and that is the whole fix this file exists for.
 *
 * It used to take the `Map` directly, called once at server construction — which meant
 * it closed over whatever sessions existed at that exact moment: none, since the server
 * had only just started. Every session created afterward, for the entire life of the
 * process, was invisible to this handler. Every `layout_*` MCP call from every agent —
 * over stdio through the shim, or over this HTTP path directly — came back "unknown
 * session", silently: the agent has no way to tell "the tool doesn't exist" from "the
 * server that owns it doesn't know about me yet", so it just falls back to guessing at
 * alternatives (confirmed live: an agent asked to render searched the filesystem for a
 * render binary instead, because the one tool that would have done it was unreachable).
 * A live lookup at request time is the fix — call `servers()` fresh on every request.
 */
export function mcpHttpHandler(servers: () => Map<string, McpServer>) {
	return async (req: Request, sessionId: string): Promise<Response> => {
		const server = servers().get(sessionId);
		if (!server)
			return new Response(JSON.stringify({ error: "unknown session" }), {
				status: 404,
			});

		if (req.method !== "POST")
			return new Response("Method not allowed", { status: 405 });

		let body: {
			id?: number | string;
			method: string;
			params?: Record<string, unknown>;
		};
		try {
			body = (await req.json()) as typeof body;
		} catch {
			return Response.json({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: "Parse error" },
			});
		}

		// Notifications carry no id and get an empty 202, matching the stdio behaviour.
		if (body.id === undefined || body.id === null)
			return new Response(null, { status: 202 });

		try {
			const result = await server.handle(body);
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		} catch (e) {
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				error: {
					code: -32603,
					message: e instanceof Error ? e.message : String(e),
				},
			});
		}
	};
}
