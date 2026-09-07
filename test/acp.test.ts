import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest, SessionUpdate } from "@layout/acp";
import { AcpClient, detectProviders, PROVIDERS } from "@layout/acp";

const AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

function client(opts: {
	onUpdate?: (s: string, u: SessionUpdate) => void;
	onPermission?: (r: PermissionRequest) => Promise<string | null>;
	onStderr?: (l: string) => void;
	env?: Record<string, string>;
	cwd?: string;
}) {
	return new AcpClient({
		command: "bun",
		args: [AGENT],
		cwd: opts.cwd,
		env: opts.env,
		events: {
			onUpdate: opts.onUpdate,
			onPermission: opts.onPermission,
			onStderr: opts.onStderr,
		},
	});
}

describe("provider registry", () => {
	test("every provider has a launch command and a probe", () => {
		for (const p of PROVIDERS) {
			expect(p.probe.length).toBeGreaterThan(0);
			expect(p.command.length).toBeGreaterThan(0);
		}
	});

	test("detection finds what is actually installed, and nothing else", async () => {
		const found = await detectProviders();
		for (const p of found) expect(p.path.length).toBeGreaterThan(0);
		// Detection is the whole of "connect your provider": no API key form.
		expect(found.every((p) => PROVIDERS.some((x) => x.id === p.id))).toBe(true);
	});
});

describe("acp client", () => {
	test("negotiates capabilities and exposes the three flags that drive behaviour", async () => {
		const c = client({});
		const init = await c.start();
		expect(init.protocolVersion).toBe(1);
		expect(c.acceptsImages).toBe(true);
		expect(c.supportsLoadSession).toBe(true);
		// This agent says no HTTP MCP, so the stdio shim is the path — which is the one
		// every ACP agent must support anyway.
		expect(c.supportsHttpMcp).toBe(false);
		await c.stop();
	});

	test("session/new carries the layout cwd and our MCP server", async () => {
		const stderr: string[] = [];
		const dir = mkdtempSync(join(tmpdir(), "acp-"));
		const c = client({ onStderr: (l) => stderr.push(l), cwd: dir });
		await c.start();
		const session = await c.newSession({
			cwd: dir,
			mcpServers: [
				{
					name: "layout",
					command: "/bin/shim",
					args: ["--stdio"],
					env: [{ name: "LAYOUT_APP_PORT", value: "1234" }],
				},
			],
		});
		expect(session.sessionId).toBe("sess-1");
		await Bun.sleep(60);
		const servers = stderr.find((l) => l.startsWith("MCP_SERVERS="))!;
		expect(servers).toContain("layout");
		expect(servers).toContain("LAYOUT_APP_PORT");
		// Path confinement: the agent's cwd is one layout's directory, not a workspace.
		expect(stderr.find((l) => l.startsWith("CWD="))).toContain(dir);
		await c.stop();
	});

	test("streams message chunks, tool calls and the plan", async () => {
		const updates: SessionUpdate[] = [];
		const c = client({ onUpdate: (_s, u) => updates.push(u) });
		await c.start();
		const sid = await c.newSession({ cwd: "/tmp" });
		const result = await c.prompt(sid, [{ type: "text", text: "widen it" }]);

		expect(result.stopReason).toBe("end_turn");
		const kinds = updates.map((u) => u.sessionUpdate);
		expect(kinds).toContain("plan");
		expect(kinds).toContain("agent_message_chunk");
		expect(kinds).toContain("tool_call");
		expect(kinds).toContain("tool_call_update");
		await c.stop();
	});

	test("a permission request reaches the handler and the answer goes back", async () => {
		const stderr: string[] = [];
		let asked: PermissionRequest | null = null;
		const c = client({
			onStderr: (l) => stderr.push(l),
			onPermission: async (r) => {
				asked = r;
				return r.options.find((o) => o.kind === "allow_once")!.optionId;
			},
		});
		await c.start();
		const sid = await c.newSession({ cwd: "/tmp" });
		await c.prompt(sid, [{ type: "text", text: "please write the file" }]);

		expect(asked).not.toBeNull();
		expect(asked!.toolCall.title).toContain("Write");
		expect(stderr.find((l) => l.startsWith("PERMISSION="))).toContain("yes");
		await c.stop();
	});

	test("with no permission handler the client refuses rather than silently allowing", async () => {
		const stderr: string[] = [];
		const c = client({ onStderr: (l) => stderr.push(l) });
		await c.start();
		const sid = await c.newSession({ cwd: "/tmp" });
		await c.prompt(sid, [{ type: "text", text: "please write the file" }]);
		// "cancelled", never an allow option id.
		expect(stderr.find((l) => l.startsWith("PERMISSION="))).toContain(
			"cancelled",
		);
		await c.stop();
	});

	test("serves fs/read_text_file back to the agent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-fs-"));
		const file = join(dir, "layout.rdl");
		await Bun.write(file, "<Report>hello from disk</Report>");
		const stderr: string[] = [];
		const c = client({
			onStderr: (l) => stderr.push(l),
			env: { FAKE_READ_PATH: file },
		});
		await c.start();
		const sid = await c.newSession({ cwd: dir });
		await c.prompt(sid, [{ type: "text", text: "readfile please" }]);
		expect(stderr.find((l) => l.startsWith("READ_BACK="))).toContain(
			"hello from disk",
		);
		await c.stop();
	});

	test("a dead agent rejects in-flight requests instead of hanging the UI", async () => {
		const c = new AcpClient({
			command: "bun",
			args: ["-e", "process.exit(3)"],
		});
		expect(c.start()).rejects.toThrow(/exited/);
	});
});
