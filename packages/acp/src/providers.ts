/**
 * Provider registry and detection.
 *
 * ACP agents reuse the user's existing CLI login — a Claude subscription, a Copilot
 * seat, a ChatGPT plan — which turns the hardest part of onboarding ("connect your
 * provider", key storage, rotation, billing confusion) into a filesystem check.
 * "We found Claude Code and Copilot" beats an API-key form.
 */

export type Provider = {
	id: string;
	name: string;
	/** The binary whose presence means this provider is usable. */
	probe: string;
	command: string;
	args: string[];
	/** True when the CLI speaks ACP itself rather than through an adapter package. */
	native: boolean;
	note?: string;
};

export const PROVIDERS: Provider[] = [
	{
		id: "claude",
		name: "Claude Code",
		probe: "claude",
		// bunx, not npx: the adapter package's bin script has a `#!/usr/bin/env node`
		// shebang, so plain npx (and plain bunx) still exec the system node to run it —
		// useless on a box where node itself won't start. `--bun` makes bunx ignore the
		// shebang and run the script on the Bun runtime this whole app already depends on,
		// so Claude Code works even when the system's node is broken.
		command: "bunx",
		args: ["--bun", "@agentclientprotocol/claude-agent-acp"],
		native: false,
		note: "Uses Zed's adapter package, run on Bun; the first run downloads it.",
	},
	{
		id: "copilot",
		name: "GitHub Copilot CLI",
		probe: "copilot",
		command: "copilot",
		args: ["--acp"],
		native: true,
		// Observed live against CLI 1.0.83: it accepts `mcpServers` on session/new and
		// then never starts them — no shim process is spawned. Asked for `layout_params`
		// it ran `layout_params` as a shell command and reported "command not found".
		// The session connects and streams fine, so this is not detectable at connect
		// time; it has to be said up front.
		note: "Connects, but ignores the layout tools — it never starts the MCP server, so the agent cannot render or inspect the layout. Prefer Claude Code until this changes.",
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		probe: "gemini",
		command: "gemini",
		args: ["--acp"],
		native: true,
	},
	{
		id: "codex",
		name: "Codex CLI",
		probe: "codex",
		// Same shebang problem, same fix — see the comment on the Claude Code provider.
		command: "bunx",
		args: ["--bun", "@zed-industries/codex-acp"],
		native: false,
	},
	{
		id: "opencode",
		name: "opencode",
		probe: "opencode",
		command: "opencode",
		args: ["acp"],
		native: true,
	},
];

export type DetectedProvider = Provider & {
	path: string;
	version?: string;
	/** The command that actually gets spawned runs. False means installed but unusable. */
	runnable: boolean;
	/** Why it cannot be used, when `runnable` is false. Shown to the user verbatim. */
	blocked?: string;
};

async function which(bin: string): Promise<string | null> {
	// Shelling out to `command -v` makes provider discovery require a POSIX shell,
	// which a normal Windows installation does not have. Bun already applies the
	// host's executable lookup rules, including PATHEXT on Windows.
	return Bun.which(bin);
}

/** Exit status of `<bin> --version`, as a cheap "does this actually run" probe. */
async function runs(bin: string): Promise<boolean> {
	try {
		const proc = Bun.spawn([bin, "--version"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

/**
 * Whether the command this provider spawns can actually run.
 *
 * The probe and the command are not always the same binary: an adapter-based provider
 * is detected by its CLI but started through `npx`. Checking only the probe is how a
 * machine with Claude Code installed and a broken node offered "Claude Code" and then
 * died with exit 127 the moment someone pressed Agent.
 */
async function commandStatus(
	p: Provider,
): Promise<{ runnable: boolean; blocked?: string }> {
	if (p.command === p.probe) return { runnable: true };
	if (!(await which(p.command)))
		return { runnable: false, blocked: `${p.command} is not installed` };
	if (!(await runs(p.command)))
		return {
			runnable: false,
			blocked: `${p.command} is installed but does not run`,
		};
	return { runnable: true };
}

async function version(bin: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([bin, "--version"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return out.trim().split("\n")[0]?.slice(0, 40);
	} catch {
		return undefined;
	}
}

/**
 * Every provider whose CLI is installed, runnable or not — a blocked one is worth
 * naming, since "Claude Code is here but its adapter will not start" is a fixable
 * situation and silence about it is not. Callers that need to *start* an agent should
 * filter on `runnable`.
 */
export async function detectProviders(): Promise<DetectedProvider[]> {
	const found: (DetectedProvider | null)[] = await Promise.all(
		PROVIDERS.map(async (p): Promise<DetectedProvider | null> => {
			const path = await which(p.probe);
			if (!path) return null;
			const [ver, status] = await Promise.all([
				version(p.probe),
				commandStatus(p),
			]);
			return { ...p, path, version: ver, ...status };
		}),
	);
	return found.filter((p): p is DetectedProvider => p !== null);
}
