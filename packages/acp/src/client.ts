/**
 * ACP client: process lifecycle, JSON-RPC over stdio, capability negotiation, sessions
 * and permission routing.
 *
 * The protocol is bidirectional — the agent calls *us* for permission and for
 * filesystem access — so this is a peer, not a request/response client.
 */
import type {
	AgentCapabilities,
	ContentBlock,
	InitializeResult,
	McpServerConfig,
	NewSessionResult,
	PermissionRequest,
	PromptResult,
	SessionUpdate,
	UsageUpdate,
} from "./types.ts";

const PROTOCOL_VERSION = 1;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type AcpEvents = {
	onUpdate?: (sessionId: string, update: SessionUpdate) => void;
	onUsage?: (sessionId: string, usage: UsageUpdate) => void;
	/** Return the chosen optionId, or null to cancel the turn. */
	onPermission?: (req: PermissionRequest) => Promise<string | null>;
	onExit?: (code: number | null) => void;
	onStderr?: (line: string) => void;
};

export type AcpClientOptions = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	events?: AcpEvents;
};

export class AcpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpError";
	}
}

export class AcpClient {
	#proc?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	#pending = new Map<number | string, Pending>();
	#nextId = 1;
	#buffer = "";
	/** Kept so a process that dies before saying anything can still explain itself. */
	#lastStderr: string[] = [];
	#capabilities: AgentCapabilities = {};
	#protocolVersion = PROTOCOL_VERSION;
	#events: AcpEvents;
	#closed = false;

	constructor(private readonly opts: AcpClientOptions) {
		this.#events = opts.events ?? {};
	}

	get capabilities(): AgentCapabilities {
		return this.#capabilities;
	}

	get protocolVersion(): number {
		return this.#protocolVersion;
	}

	get running(): boolean {
		return this.#proc !== undefined && !this.#closed;
	}

	/** Does this provider accept images at all? Drives whether we ration pixels or omit them. */
	get acceptsImages(): boolean {
		return this.#capabilities.promptCapabilities?.image === true;
	}

	get supportsHttpMcp(): boolean {
		return this.#capabilities.mcpCapabilities?.http === true;
	}

	get supportsLoadSession(): boolean {
		return this.#capabilities.loadSession === true;
	}

	async start(): Promise<InitializeResult> {
		if (this.#proc) throw new Error("Already started");
		this.#proc = Bun.spawn([this.opts.command, ...(this.opts.args ?? [])], {
			cwd: this.opts.cwd,
			env: { ...process.env, ...this.opts.env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as Bun.Subprocess<"pipe", "pipe", "pipe">;

		void this.#pumpStdout();
		void this.#pumpStderr();
		void this.#proc.exited.then((code) => {
			this.#closed = true;
			// Anything still waiting will never be answered; fail it rather than hang the UI.
			const why = this.#exitMessage(code);
			for (const [, p] of this.#pending) p.reject(new AcpError(why));
			this.#pending.clear();
			this.#events.onExit?.(code);
		});

		const result = (await this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: false,
			},
			clientInfo: { name: "layout-agent", version: "0.1.0" },
		})) as InitializeResult;

		this.#capabilities = result.agentCapabilities ?? {};
		this.#protocolVersion = result.protocolVersion ?? PROTOCOL_VERSION;
		return result;
	}

	/**
	 * `cwd` is one layout's directory, never the workspace. The agent should not be able
	 * to reach another client's layouts, and confinement is cheaper to enforce here than
	 * to police per tool call.
	 *
	 * Returns the full result, not just the id: `modes` and `configOptions` are what a
	 * model/mode picker in the UI is built from, and they only ever arrive here, once, at
	 * session creation.
	 */
	async newSession(opts: {
		cwd: string;
		mcpServers?: McpServerConfig[];
	}): Promise<NewSessionResult> {
		return (await this.request("session/new", {
			cwd: opts.cwd,
			mcpServers: opts.mcpServers ?? [],
		})) as NewSessionResult;
	}

	async loadSession(
		sessionId: string,
		opts: { cwd: string; mcpServers?: McpServerConfig[] },
	): Promise<void> {
		await this.request("session/load", {
			sessionId,
			cwd: opts.cwd,
			mcpServers: opts.mcpServers ?? [],
		});
	}

	async prompt(
		sessionId: string,
		blocks: ContentBlock[],
	): Promise<PromptResult> {
		return (await this.request("session/prompt", {
			sessionId,
			prompt: blocks,
		})) as PromptResult;
	}

	async cancel(sessionId: string): Promise<void> {
		await this.notify("session/cancel", { sessionId });
	}

	/**
	 * Switches the agent's own permission mode — "always ask", "auto-accept edits", "plan
	 * only", and so on, whatever the connected provider actually offers (see
	 * `ConfigOption`). This is the real control for "ask before edit" / "auto mode": it is
	 * the agent deciding whether to call `session/request_permission` at all, which our
	 * own permission gate cannot compensate for if the agent skips it — confirmed live: an
	 * ACP-native agent in its default mode edited a file with zero permission request.
	 */
	async setMode(sessionId: string, modeId: string): Promise<void> {
		await this.request("session/set_mode", { sessionId, modeId });
	}

	/** Switches the model a session uses, for providers whose `configOptions` offer one. */
	async setModel(sessionId: string, modelId: string): Promise<void> {
		await this.request("session/set_model", { sessionId, modelId });
	}

	async stop(): Promise<void> {
		this.#closed = true;
		try {
			this.#proc?.stdin.end();
		} catch {
			/* already gone */
		}
		this.#proc?.kill();
		await this.#proc?.exited;
	}

	// --- JSON-RPC plumbing ---------------------------------------------------

	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.#proc || this.#closed) throw new AcpError("Agent is not running");
		const id = this.#nextId++;
		const promise = new Promise<unknown>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
		});
		this.#write({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		if (!this.#proc || this.#closed) return;
		this.#write({ jsonrpc: "2.0", method, params });
	}

	#write(msg: unknown): void {
		this.#proc?.stdin.write(`${JSON.stringify(msg)}\n`);
		void this.#proc?.stdin.flush();
	}

	async #pumpStdout(): Promise<void> {
		const decoder = new TextDecoder();
		if (!this.#proc) return;
		for await (const chunk of this.#proc.stdout) {
			this.#buffer += decoder.decode(chunk as Uint8Array, { stream: true });
			let nl = this.#buffer.indexOf("\n");
			while (nl !== -1) {
				const line = this.#buffer.slice(0, nl).trim();
				this.#buffer = this.#buffer.slice(nl + 1);
				if (line) await this.#onMessage(line);
				nl = this.#buffer.indexOf("\n");
			}
		}
	}

	async #pumpStderr(): Promise<void> {
		const decoder = new TextDecoder();
		if (!this.#proc) return;
		let buf = "";
		for await (const chunk of this.#proc.stderr) {
			buf += decoder.decode(chunk as Uint8Array, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim()) {
					// The agent's own last words are the whole diagnosis when it dies during
					// startup — a missing shared library, a login prompt, an adapter that is not
					// installed. Keep a few lines so the exit code does not travel alone.
					this.#lastStderr.push(line.trim());
					if (this.#lastStderr.length > 5) this.#lastStderr.shift();
					this.#events.onStderr?.(line);
				}
				nl = buf.indexOf("\n");
			}
		}
	}

	/**
	 * An exit code on its own sends someone to read source. 127 in particular means the
	 * command could not be run at all, which is a different problem from an agent that
	 * started and then failed — and on a machine where the interpreter behind an adapter
	 * is broken, the reason is sitting in stderr.
	 */
	#exitMessage(code: number | null): string {
		const command = [this.opts.command, ...(this.opts.args ?? [])].join(" ");
		const said = this.#lastStderr.join(" / ");
		const hint =
			code === 127
				? " — exit 127 means the command could not be run: it is missing, or its interpreter is broken"
				: "";
		return `Agent process exited (${code})${hint}. Command: ${command}${said ? `. It said: ${said}` : ""}`;
	}

	async #onMessage(line: string): Promise<void> {
		let msg: {
			id?: number | string;
			method?: string;
			params?: Record<string, unknown>;
			result?: unknown;
			error?: { code: number; message: string; data?: unknown };
		};
		try {
			msg = JSON.parse(line);
		} catch {
			this.#events.onStderr?.(`[acp] unparseable line: ${line.slice(0, 200)}`);
			return;
		}

		// A response to something we sent.
		if (msg.id !== undefined && msg.method === undefined) {
			const pending = this.#pending.get(msg.id);
			if (!pending) return;
			this.#pending.delete(msg.id);
			if (msg.error)
				pending.reject(
					new AcpError(msg.error.message, msg.error.code, msg.error.data),
				);
			else pending.resolve(msg.result);
			return;
		}

		if (msg.method === undefined) return;

		// The agent calling us.
		if (msg.id === undefined) {
			this.#handleNotification(msg.method, msg.params ?? {});
			return;
		}

		try {
			const result = await this.#handleRequest(msg.method, msg.params ?? {});
			this.#write({ jsonrpc: "2.0", id: msg.id, result });
		} catch (e) {
			this.#write({
				jsonrpc: "2.0",
				id: msg.id,
				error: {
					code: -32603,
					message: e instanceof Error ? e.message : String(e),
				},
			});
		}
	}

	#handleNotification(method: string, params: Record<string, unknown>): void {
		if (method === "session/update") {
			const sessionId = String(params.sessionId ?? "");
			const update = params.update as SessionUpdate | undefined;
			if (update) this.#events.onUpdate?.(sessionId, update);
			// Usage arrives either as its own update kind or alongside; handle both shapes.
			const usage = params.usage as UsageUpdate | undefined;
			if (usage) this.#events.onUsage?.(sessionId, usage);
			return;
		}
		if (method === "session/usage" || method === "usage_update") {
			this.#events.onUsage?.(
				String(params.sessionId ?? ""),
				params as UsageUpdate,
			);
		}
	}

	async #handleRequest(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case "session/request_permission": {
				const req = params as unknown as PermissionRequest;
				const chosen = this.#events.onPermission
					? await this.#events.onPermission(req)
					: // With no handler we must not silently allow a write to someone's layout.
						null;
				if (chosen === null) return { outcome: { outcome: "cancelled" } };
				return { outcome: { outcome: "selected", optionId: chosen } };
			}
			case "fs/read_text_file": {
				const path = String(params.path ?? "");
				const content = await Bun.file(path).text();
				return { content };
			}
			case "fs/write_text_file": {
				const path = String(params.path ?? "");
				await Bun.write(path, String(params.content ?? ""));
				return null;
			}
			default:
				throw new AcpError(`Unhandled method: ${method}`, -32601);
		}
	}
}
