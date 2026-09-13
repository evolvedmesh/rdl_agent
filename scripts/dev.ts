/**
 * Dev launcher: build the view, then run the app through Hutch.
 *
 * WEBKIT_DISABLE_COMPOSITING_MODE is not gratuitous — WebKitGTK's accelerated
 * compositing fails under XWayland on some compositors ("X11 Error: GLXBadWindow") and
 * the webview then paints nothing at all, with no error in the app's own logs.
 */
const env = { ...process.env, WEBKIT_DISABLE_COMPOSITING_MODE: "1" };

const vite = Bun.spawn(["bunx", "vite", "build"], {
	stdout: "inherit",
	stderr: "inherit",
});
if ((await vite.exited) !== 0) process.exit(1);

const args = process.argv.slice(2);
const app = Bun.spawn(
	[
		"bunx",
		"electrobun",
		"dev",
		...(args.includes("--watch") ? ["--watch"] : []),
	],
	{ env, stdout: "inherit", stderr: "inherit" },
);
process.exit(await app.exited);
