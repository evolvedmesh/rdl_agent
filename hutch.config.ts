export default {
	// Bun stays the package manager: this is a bun workspace and the tests, typecheck
	// and lint all run through it. Independent of build.mainProcess.
	packageManager: "bun",
	// Pinned exactly. Electrobun 2.x moves fast and the project takes no issues or PRs,
	// so a floating channel would let a release break the build unattended.
	electrobun: {
		version: "2.0.1",
	},
	scripts: {
		install: ["hutch", "pm", "install"],
		"ui:build": ["hutch", "pm", "exec", "--", "vite", "build"],
		dev: ["bun", "run", "scripts/dev.ts"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
		"build:canary": ["hutch", "electrobun", "build", "--env=canary"],
	},
};
