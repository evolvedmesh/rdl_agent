/**
 * The MCP surface. One tool set, two transports.
 *
 * stdio is the transport every ACP agent must support, so it is the path that always
 * works. localhost HTTP exists so the desktop app and the agent share one render engine
 * and therefore one PDF — the user should be looking at the render the agent is
 * reasoning about, not a second copy of it.
 */

export { mcpHttpHandler } from "./http.ts";
export type { Tool, ToolContent, ToolResult } from "./server.ts";
export { failure, log, McpServer, text } from "./server.ts";
export { runStdioShim } from "./shim.ts";
export type { LoopLimits, ToolContext } from "./tools.ts";
export { createLayoutTools } from "./tools.ts";
