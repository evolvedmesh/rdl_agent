import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };

export default {
	app: {
		name: "Layout Agent",
		identifier: "dev.pinetworks.layout-agent",
		version: pkg.version,
		description: "Agent-driven editor for Business Central report layouts",
	},
	build: {
		// A real Bun runtime, not Cottontail: the core needs bun:sqlite, Bun.serve and
		// Bun.spawn, and the bundled `bin/bun` is what the MCP shim re-execs.
		mainProcess: "bun",
		bun: {
			entrypoint: "apps/desktop/src/main.ts",
			minify: true,
			sourcemap: "linked",
		},
		// Vite owns the view build — Hutch cannot serialise bundler plugins across its
		// config boundary, and Tailwind needs one. `copy` lifts the result into the bundle.
		views: {},
		copy: {
			"apps/desktop/dist": "views/mainview",
		},
		watch: ["packages"],
		linux: { bundleCEF: false },
		mac: { bundleCEF: false },
		win: { bundleCEF: false },
	},
	runtime: {
		exitOnLastWindowClosed: true,
	},
} satisfies ElectrobunConfig;
