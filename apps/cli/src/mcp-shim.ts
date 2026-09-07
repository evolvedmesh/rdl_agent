#!/usr/bin/env bun
/**
 * The stdio MCP shim, standalone.
 *
 * The real implementation is `runStdioShim` in `@layout/mcp` — shared so the compiled
 * single-file build can be its own shim (it re-execs itself as `<app> mcp-shim …`). This
 * file stays for `bun apps/cli/src/mcp-shim.ts …` and for the wiring test.
 *
 * Hard rule: stdout carries JSON-RPC and nothing else.
 */
import { runStdioShim } from "@layout/mcp";

await runStdioShim();
