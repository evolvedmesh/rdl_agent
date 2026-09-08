/**
 * The desktop shell's main process.
 *
 * Electrobun runs this on a real Bun runtime (`build.mainProcess: "bun"`), which is what
 * lets the core process — HTTP server, WebSocket, render engine, ACP subprocesses, MCP
 * server — live here rather than in a sidecar: it needs bun:sqlite, Bun.serve and
 * Bun.spawn. The UI is a webview pointed at that same server, so nothing here is
 * load-bearing for the core and a plain browser can drive the identical app.
 */

import { runStdioShim } from "@layout/mcp";
import { createApp } from "@layout/server";

// One bundle is the whole app. Route the two non-GUI invocations before touching
// anything native — neither loads the window wrapper, so both work headless:
//   <app> mcp-shim --stdio --session <id>   the per-session MCP proxy an agent spawns
//   <app> serve                             headless core, for a browser to drive
const cliArgs = process.argv.slice(2);

if (cliArgs[0] === "mcp-shim" || cliArgs.includes("--stdio")) {
	await runStdioShim(cliArgs);
	process.exit(0);
}

const headless = cliArgs[0] === "serve" || cliArgs[0] === "--headless";

const app = await createApp({ uiDir: await resolveUiDir() });

if (headless) {
	console.log(
		`layout-agent listening on ${app.url}` +
			(app.replaying ? "  (REPLAY MODE)" : ""),
	);
	process.on("SIGINT", () => {
		void app.shutdown().then(() => process.exit(0));
	});
	await new Promise(() => {}); // serve until killed; never fall through to the GUI
}

console.error(
	`[layout] core listening on 127.0.0.1:${app.server.port}` +
		(app.replaying ? "  (REPLAY MODE)" : ""),
);

const { BrowserWindow } = await import("electrobun/main");

new BrowserWindow({
	title: "Layout Agent",
	// Same origin as /api and /ws: no CORS, and the launch token rides in the URL so
	// only this window starts out holding it.
	url: app.url,
	frame: { width: 1440, height: 900, x: 80, y: 60 },
});

/**
 * Where the built UI lives. Packaged, Hutch copies Vite's output beside the main
 * process bundle; in dev it sits in the workspace. First hit wins.
 */
async function resolveUiDir(): Promise<string | undefined> {
	const { join } = await import("node:path");
	const candidates = [
		process.env.LAYOUT_UI_DIR,
		join(import.meta.dir, "..", "views", "mainview"), // packaged bundle
		join(import.meta.dir, "..", "dist"), // apps/desktop/dist in dev
	].filter((c): c is string => Boolean(c));

	for (const dir of candidates) {
		if (await Bun.file(join(dir, "index.html")).exists()) return dir;
	}
	return undefined;
}
