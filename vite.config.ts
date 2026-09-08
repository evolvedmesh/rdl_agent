import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
	root: resolve(root, "apps/desktop/src/view"),
	base: "./",
	plugins: [react(), tailwindcss()],
	// Deliberately no alias for @layout/*. The view imports types only, and those are
	// erased before resolution — so a value import fails the build loudly instead of
	// quietly pulling bun:sqlite and node:fs into a browser bundle.
	build: {
		outDir: resolve(root, "apps/desktop/dist"),
		emptyOutDir: true,
		// WebKitGTK 4.1 / WKWebView / WebView2 all clear this; it keeps output small by
		// not down-levelling syntax the system webviews already support.
		target: "safari18",
		sourcemap: true,
	},
});
