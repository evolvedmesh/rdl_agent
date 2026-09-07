/**
 * Agent sessions: one ACP process per session, one MCP tool set per session, one layout.
 *
 * This is where the three protocols meet. ACP carries the conversation; MCP carries the
 * tools; the render engine is shared with the UI so the human is looking at the same PDF
 * the agent is reasoning about.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AcpClient,
	type ConfigOption,
	detectProviders,
	type PermissionRequest,
	type SessionUpdate,
	type ToolCallContentItem,
	type UsageUpdate,
} from "@layout/acp";
import type {
	LayoutDetail,
	RenderEngine,
	Store,
	WatchManager,
} from "@layout/core";
import { unifiedDiff } from "@layout/feedback";
import { createLayoutTools, McpServer } from "@layout/mcp";

export type SessionStatus =
	| "starting"
	| "idle"
	| "thinking"
	| "awaiting-permission"
	| "error"
	| "stopped";

export type ToolCallView = {
	id: string;
	title: string;
	kind?: string;
	status: string;
	/** File(s) the tool touched, from the update's own `locations` — not guessed from the title. */
	locations: string[];
	/**
	 * A unified-diff patch for GPUIX's `<diff>` element, when the update carried an edit's
	 * before/after text. This is the piece that answers "did it actually change the file":
	 * without it, an edit tool call was a title and a checkmark, nothing else.
	 */
	diffPatch: string | null;
	/** Short text from a read/search/shell result, when the update carried one. */
	preview: string | null;
};

/**
 * One ordered entry in the conversation. Messages and tool calls used to be two
 * separate arrays, always rendered as two separate blocks — every tool call after every
 * message, regardless of when either actually happened. A multi-turn conversation (ask,
 * edit, render, ask again) came out as [all the text][all the tool calls, lumped], with
 * no way to tell which edit belonged to which request. This is what fixes that: one
 * array, in the order things actually occurred, that both the UI and `#onUpdate` share.
 */
export type TimelineItem =
	| {
			kind: "message";
			id: string;
			role: "agent" | "user" | "thought";
			text: string;
	  }
	| { kind: "tool"; id: string; call: ToolCallView };

export type SessionEvent =
	| { type: "status"; status: SessionStatus }
	| { type: "timeline"; item: TimelineItem }
	| {
			type: "plan";
			entries: { content: string; status?: string; priority?: string }[];
	  }
	| { type: "usage"; usage: UsageUpdate }
	| { type: "permission"; request: PendingPermission | null }
	| { type: "render"; pdfPath: string; pageCount: number; contentHash: string }
	| { type: "config"; modeId: string | null }
	| { type: "error"; message: string };

export type PendingPermission = {
	id: string;
	title: string;
	kind?: string;
	rawInput?: unknown;
	options: { optionId: string; name: string; kind: string }[];
};

export type SessionView = {
	id: string;
	layoutId: string;
	providerId: string;
	providerName: string;
	status: SessionStatus;
	timeline: TimelineItem[];
	plan: { content: string; status?: string; priority?: string }[];
	usage: UsageUpdate;
	permission: PendingPermission | null;
	acceptsImages: boolean;
	/**
	 * Whatever this provider actually offers to adjust — model, permission mode, effort,
	 * anything with an `id`/`options` shape (see `ConfigOption`). Empty for a provider
	 * that offers nothing to adjust, which the UI treats as "no controls to show", not
	 * as an error.
	 */
	configOptions: ConfigOption[];
	/** The `id` of the currently selected `configOptions` entry with `id === "mode"`, if any. */
	modeId: string | null;
	/** The very first render of the session, kept for the before/after comparison. */
	firstPdfPath: string | null;
	latestPdfPath: string | null;
	error: string | null;
	/**
	 * True once this session has been rebuilt from the store after an app restart and is
	 * not live yet. The UI shows a "restored — Resume to continue" bar for these; it clears
	 * when `resume()` gets the agent running again.
	 */
	restored: boolean;
};

/**
 * Auto-allow reads and our own layout_* tools; always ask before a write.
 * The agent's edits to a customer's layout are the one thing a human must see coming.
 */
function autoDecision(req: PermissionRequest): string | null {
	const title = (req.toolCall.title ?? "").toLowerCase();
	const kind = (req.toolCall.kind ?? "").toLowerCase();
	const isRead =
		kind === "read" ||
		/\bread\b|\bsearch\b|\bgrep\b|\bglob\b|\blist\b/.test(title);
	const isOurTool = title.includes("layout_");
	if (!isRead && !isOurTool) return null;
	const allow =
		req.options.find((o) => o.kind === "allow_always") ??
		req.options.find((o) => o.kind === "allow_once");
	return allow?.optionId ?? null;
}

/**
 * Everything needed to rebuild a `Session`'s view from the store after an app restart.
 * The process is gone, so `status` always comes back `stopped` — `resume()` is what
 * spawns the agent again and runs `session/load`.
 */
export type SessionRestore = {
	acpSessionId: string | null;
	timeline: TimelineItem[];
	plan: SessionView["plan"];
	usage: UsageUpdate;
	configOptions: ConfigOption[];
	modeId: string | null;
	firstPdfPath: string | null;
	latestPdfPath: string | null;
	error: string | null;
};

export class Session {
	readonly id: string;
	readonly view: SessionView;
	#client: AcpClient;
	#acpSessionId?: string;
	#mcp: McpServer;
	#listeners = new Set<(e: SessionEvent) => void>();
	#pendingPermission?: { resolve: (id: string | null) => void };
	#chunkBuffer = "";
	/** Monotonic per session; assigned to each timeline item so an update rewrites its row. */
	#nextSeq = 0;
	#seqById = new Map<string, number>();
	/** True only while `session/load` is replaying updates we already have persisted. */
	#loading = false;

	constructor(
		id: string,
		private readonly layout: LayoutDetail,
		private readonly deps: {
			store: Store;
			engine: RenderEngine;
			watcher?: WatchManager;
			workDir: string;
			providerId: string;
			providerName: string;
			command: string;
			args: string[];
		},
		restore?: SessionRestore,
	) {
		this.id = id;
		this.view = {
			id,
			layoutId: layout.id,
			providerId: deps.providerId,
			providerName: deps.providerName,
			status: restore ? "stopped" : "starting",
			timeline: restore?.timeline ?? [],
			plan: restore?.plan ?? [],
			usage: restore?.usage ?? {},
			permission: null,
			acceptsImages: false,
			configOptions: restore?.configOptions ?? [],
			modeId: restore?.modeId ?? null,
			firstPdfPath: restore?.firstPdfPath ?? null,
			latestPdfPath: restore?.latestPdfPath ?? null,
			error: restore?.error ?? null,
			restored: restore !== undefined,
		};
		if (restore) {
			this.#acpSessionId = restore.acpSessionId ?? undefined;
			for (const item of restore.timeline) {
				const seq = this.#nextSeq++;
				this.#seqById.set(item.id, seq);
			}
		}

		const watcher = deps.watcher;
		this.#mcp = new McpServer({ name: "layout", version: "0.1.0" }).tools(
			createLayoutTools({
				store: deps.store,
				engine: deps.engine,
				layoutId: layout.id,
				workDir: deps.workDir,
				// The watcher is NOT held suppressed for the whole session any more — the
				// agent's edits are meant to hot-reload. This suppression is scoped to one
				// explicit `layout_render` call, so that render and the watcher's own render of
				// the same bytes do not both make a live BC round trip. WatchManager.suppress()
				// refcounts, so overlapping renders each hold their own.
				suppressWatch: watcher ? (lid) => watcher.suppress(lid) : undefined,
				onCall: ({ tool, isError }) => {
					this.#pushTimeline({
						kind: "tool",
						id: `${tool}-${Date.now()}`,
						call: {
							id: `${tool}-${Date.now()}`,
							title: tool,
							status: isError ? "failed" : "completed",
							locations: [],
							diffPatch: null,
							preview: null,
						},
					});
				},
			}),
		);

		this.#client = this.#buildClient(deps.command, deps.args);

		// The engine is shared, so a render the agent triggers reaches the UI's PDF pane too.
		deps.engine.on((e) => {
			if (e.type !== "finished" || e.layoutId !== layout.id) return;
			if (!e.result.ok) return;
			this.view.latestPdfPath = e.result.pdfPath;
			this.view.firstPdfPath ??= e.result.pdfPath;
			this.#emit({
				type: "render",
				pdfPath: e.result.pdfPath,
				pageCount: e.result.pageCount,
				contentHash: e.result.contentHash,
			});
		});
	}

	#buildClient(command: string, args: string[]): AcpClient {
		return new AcpClient({
			command,
			args,
			cwd: dirname(this.layout.filePath),
			events: {
				onUpdate: (_s, u) => this.#onUpdate(u),
				onUsage: (_s, usage) => {
					this.view.usage = { ...this.view.usage, ...usage };
					this.#emit({ type: "usage", usage: this.view.usage });
				},
				onPermission: (req) => this.#onPermission(req),
				onStderr: (line) => {
					if (/error|fatal|panic/i.test(line))
						this.#emit({ type: "error", message: line });
				},
				onExit: (code) => {
					this.#setStatus(code === 0 ? "stopped" : "error");
					if (code !== 0) {
						this.view.error = `Agent process exited with code ${code}`;
						this.#emit({ type: "error", message: this.view.error });
					}
				},
			},
		});
	}

	/**
	 * Give a restored session the real command to spawn. The persisted row only kept the
	 * provider id and name, so `resume()` re-detects the provider and passes its command
	 * here before starting the client.
	 */
	setSpawn(command: string, args: string[]): void {
		if (this.#client.running) return;
		this.#client = this.#buildClient(command, args);
	}

	on(listener: (e: SessionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(e: SessionEvent): void {
		for (const l of this.#listeners) {
			try {
				l(e);
			} catch {
				/* a bad listener must not break a session */
			}
		}
		this.#persist();
	}

	/**
	 * Mirror the current view into the store so the chat survives an app restart. The
	 * transcript rows are written separately as items arrive (`#pushTimeline`); this is
	 * just the row that carries status, plan, cost, the config picker state and the
	 * before/after render paths. Best-effort — a store hiccup must never break a live
	 * session.
	 */
	#persist(): void {
		try {
			this.deps.store.upsertSession({
				id: this.id,
				layoutId: this.view.layoutId,
				providerId: this.view.providerId,
				providerName: this.view.providerName,
				acpSessionId: this.#acpSessionId ?? null,
				status: this.view.status,
				modeId: this.view.modeId,
				configOptions: this.view.configOptions,
				usage: this.view.usage,
				plan: this.view.plan,
				firstPdfPath: this.view.firstPdfPath,
				latestPdfPath: this.view.latestPdfPath,
				error: this.view.error,
			});
		} catch (e) {
			console.error("[session] persist failed", e);
		}
	}

	#setStatus(status: SessionStatus): void {
		this.view.status = status;
		this.#emit({ type: "status", status });
	}

	#pushTimeline(item: TimelineItem): void {
		// Dedupe by id: a replayed `session/load` update, or an agent that re-sends a
		// tool_call, must rewrite the existing entry in place, not stack a copy on top.
		const existingSeq = this.#seqById.get(item.id);
		if (existingSeq !== undefined) {
			const idx = this.view.timeline.findIndex((t) => t.id === item.id);
			if (idx >= 0) this.view.timeline[idx] = item;
			this.#persistTimelineItem(existingSeq, item);
			this.#emit({ type: "timeline", item });
			return;
		}
		const seq = this.#nextSeq++;
		this.#seqById.set(item.id, seq);
		this.view.timeline.push(item);
		this.#persistTimelineItem(seq, item);
		this.#emit({ type: "timeline", item });
	}

	#persistTimelineItem(seq: number, item: TimelineItem): void {
		try {
			this.deps.store.appendTimelineItem(this.id, seq, item);
		} catch (e) {
			console.error("[session] timeline persist failed", e);
		}
	}

	/** The live tool-call entry for an id, if the timeline is currently holding one. */
	#findToolCall(id: string): ToolCallView | undefined {
		for (let i = this.view.timeline.length - 1; i >= 0; i--) {
			const item = this.view.timeline[i];
			if (item?.kind === "tool" && item.call.id === id) return item.call;
		}
		return undefined;
	}

	/**
	 * The stdio shim the agent spawns to reach this session's tools.
	 *
	 * There is no separate shim file to point at any more — the app is its own shim.
	 * `command` is whatever is running us (`process.execPath`), and the args re-enter the
	 * same entrypoint in shim mode:
	 *   - compiled single binary: `<app> mcp-shim --stdio --session <id>`
	 *   - dev (`bun <main> …`):   `bun <main> mcp-shim --stdio --session <id>`
	 * `Bun.main` inside a `--compile` build lives under `/$bunfs/`, which is the tell.
	 */
	mcpServerConfig(port: number) {
		const compiled =
			Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");
		const reenter = compiled ? [] : [Bun.main];
		return {
			name: "layout",
			command: process.execPath,
			args: [...reenter, "mcp-shim", "--stdio", "--session", this.id],
			env: [{ name: "LAYOUT_APP_PORT", value: String(port) }],
		};
	}

	get mcp(): McpServer {
		return this.#mcp;
	}

	async start(
		mcpServers: ReturnType<Session["mcpServerConfig"]>[],
	): Promise<void> {
		const init = await this.#client.start();
		this.view.acceptsImages = this.#client.acceptsImages;
		// A provider that cannot take images gets a text-only loop rather than a broken one.
		// Pushed onto the timeline, not just emitted: the emit-only version of this notice
		// never actually reached anyone, since the client applies a session event by
		// re-fetching the view rather than the event's own payload — a transient-only push
		// was invisible the moment the refresh landed.
		if (!this.view.acceptsImages) {
			this.#pushTimeline({
				kind: "message",
				id: crypto.randomUUID(),
				role: "agent",
				text:
					`[${this.deps.providerName} did not advertise image support, so page renders will be ` +
					`described in text rather than shown. Capability negotiated at connect time: ` +
					`${JSON.stringify(init.agentCapabilities?.promptCapabilities ?? {})}]`,
			});
		}
		await mkdir(this.deps.workDir, { recursive: true });
		const session = await this.#client.newSession({
			cwd: dirname(this.layout.filePath),
			mcpServers,
		});
		this.#acpSessionId = session.sessionId;
		// Whatever this provider actually lets a session adjust — model, permission mode,
		// effort, anything with the generic {id, options} shape — surfaced as-is rather than
		// hardcoded to one provider's option ids, which is what lets one UI control work for
		// Claude Code's "mode"/"model" and opencode's "mode"/"model" alike.
		this.view.configOptions = session.configOptions ?? [];
		this.view.modeId =
			session.modes?.currentModeId ??
			session.configOptions?.find((o) => o.id === "mode")?.currentValue ??
			null;
		this.#emit({ type: "config", modeId: this.view.modeId });
		this.#setStatus("idle");
	}

	/**
	 * Bring a restored chat back to life: spawn the agent again and, if the provider
	 * supports `session/load`, hand it back the ACP session id so it recovers its own
	 * context. A provider that cannot `loadSession` (or a session that never got an ACP id)
	 * stays `stopped` with a note — the transcript is still fully readable, the human just
	 * has to start a fresh session to keep working on this layout.
	 */
	async resume(
		mcpServers: ReturnType<Session["mcpServerConfig"]>[],
	): Promise<void> {
		if (this.#client.running) return;
		this.#setStatus("starting");
		try {
			await this.#client.start();
			this.view.acceptsImages = this.#client.acceptsImages;

			if (!this.#client.supportsLoadSession || !this.#acpSessionId) {
				await this.#client.stop();
				this.view.error =
					"This agent can't reopen a past conversation. The transcript above is kept for " +
					"reference — start a new session on this layout to keep working.";
				this.#setStatus("stopped");
				return;
			}

			await mkdir(this.deps.workDir, { recursive: true });
			this.#loading = true;
			try {
				await this.#client.loadSession(this.#acpSessionId, {
					cwd: dirname(this.layout.filePath),
					mcpServers,
				});
			} finally {
				this.#loading = false;
			}

			this.view.error = null;
			this.view.restored = false;
			this.#setStatus("idle");
		} catch (e) {
			// Tear the half-started process down so a second Resume can try again from
			// scratch rather than hitting the `#client.running` early-return.
			await this.#client.stop().catch(() => {});
			this.view.error = e instanceof Error ? e.message : String(e);
			this.#setStatus("error");
			this.#emit({ type: "error", message: this.view.error });
		}
	}

	async prompt(message: string): Promise<void> {
		if (!this.#acpSessionId) throw new Error("Session not started");
		this.#pushTimeline({
			kind: "message",
			id: crypto.randomUUID(),
			role: "user",
			text: message,
		});
		this.#setStatus("thinking");
		try {
			await this.#client.prompt(this.#acpSessionId, [
				{ type: "text", text: message },
			]);
			this.#flushChunks();
			this.#setStatus("idle");
		} catch (e) {
			this.#flushChunks();
			this.view.error = e instanceof Error ? e.message : String(e);
			this.#setStatus("error");
			this.#emit({ type: "error", message: this.view.error });
		}
	}

	async cancel(): Promise<void> {
		if (this.#acpSessionId) await this.#client.cancel(this.#acpSessionId);
		this.#setStatus("idle");
	}

	/**
	 * Switches the agent's own permission mode — "Manual: always ask before making
	 * changes", "Accept edits", "Plan", whatever the connected provider offers under its
	 * `configOptions` entry with `id === "mode"`. This is the real "ask before edit" /
	 * "auto mode" control: confirmed live that an ACP-native agent in its default mode
	 * can edit a file with zero permission request, so nothing on our side can retrofit
	 * a per-edit prompt the agent itself never asks for — the honest fix is to expose the
	 * provider's own switch, not to fake one.
	 */
	async setMode(modeId: string): Promise<void> {
		if (!this.#acpSessionId) throw new Error("Session not started");
		try {
			await this.#client.setMode(this.#acpSessionId, modeId);
			this.view.modeId = modeId;
			this.#emit({ type: "config", modeId });
		} catch (e) {
			// Not every provider supports every mode id it advertised a moment ago; say so
			// rather than leaving the UI's dropdown silently out of sync with reality.
			const message = `Could not switch mode: ${e instanceof Error ? e.message : String(e)}`;
			this.#emit({ type: "error", message });
		}
	}

	/** Switches the model, for a provider whose `configOptions` offer one (`id === "model"`). */
	async setModel(modelId: string): Promise<void> {
		if (!this.#acpSessionId) throw new Error("Session not started");
		try {
			await this.#client.setModel(this.#acpSessionId, modelId);
			// Reflected into configOptions, not tracked separately the way modeId is: the
			// model dropdown reads its selected value straight off `configOptions`, and
			// without this the switch would succeed while the dropdown kept showing the
			// model that was just replaced.
			const model = this.view.configOptions.find((o) => o.id === "model");
			if (model) model.currentValue = modelId;
			this.#emit({ type: "config", modeId: this.view.modeId });
		} catch (e) {
			const message = `Could not switch model: ${e instanceof Error ? e.message : String(e)}`;
			this.#emit({ type: "error", message });
		}
	}

	async stop(): Promise<void> {
		await this.#client.stop();
		this.#setStatus("stopped");
	}

	resolvePermission(optionId: string | null): void {
		this.#pendingPermission?.resolve(optionId);
		this.#pendingPermission = undefined;
		this.view.permission = null;
		this.#emit({ type: "permission", request: null });
		this.#setStatus("thinking");
	}

	async #onPermission(req: PermissionRequest): Promise<string | null> {
		const auto = autoDecision(req);
		if (auto !== null) return auto;

		const pending: PendingPermission = {
			id: req.toolCall.toolCallId,
			title: req.toolCall.title ?? "Agent requested permission",
			kind: req.toolCall.kind,
			rawInput: req.toolCall.rawInput,
			options: req.options.map((o) => ({
				optionId: o.optionId,
				name: o.name,
				kind: o.kind,
			})),
		};
		this.view.permission = pending;
		this.#setStatus("awaiting-permission");
		this.#emit({ type: "permission", request: pending });

		return new Promise<string | null>((resolve) => {
			this.#pendingPermission = { resolve };
		});
	}

	/**
	 * Message chunks arrive token by token; coalesce into one timeline entry so the
	 * conversation is not rebuilt once per token. This is also the point that decides
	 * *where* the finished message lands relative to any tool calls that happened during
	 * the same turn — pushed only when the turn is done, so it always lands after them,
	 * matching what actually happened rather than what arrived first on the wire.
	 */
	#flushChunks(): void {
		if (!this.#chunkBuffer) return;
		this.#pushTimeline({
			kind: "message",
			id: crypto.randomUUID(),
			role: "agent",
			text: this.#chunkBuffer,
		});
		this.#chunkBuffer = "";
	}

	#onUpdate(u: SessionUpdate): void {
		// While `resume()` runs `session/load`, the agent replays the whole conversation as
		// `session/update` notifications. We already have that transcript persisted and it is
		// the display source of truth, so ignore the replay — `session/load` is only there to
		// restore the agent's own context.
		if (this.#loading) return;
		switch (u.sessionUpdate) {
			case "agent_message_chunk": {
				if (u.content.type === "text") this.#chunkBuffer += u.content.text;
				break;
			}
			case "agent_thought_chunk": {
				if (u.content.type === "text") {
					this.#pushTimeline({
						kind: "message",
						id: crypto.randomUUID(),
						role: "thought",
						text: u.content.text,
					});
				}
				break;
			}
			case "tool_call": {
				const { diffPatch, preview } = summarizeToolContent(u.content);
				const call: ToolCallView = {
					id: u.toolCallId,
					title: u.title ?? u.toolCallId,
					kind: u.kind,
					status: u.status ?? "pending",
					locations: (u.locations ?? []).map((l) => l.path),
					diffPatch,
					preview,
				};
				this.#pushTimeline({ kind: "tool", id: call.id, call });
				break;
			}
			case "tool_call_update": {
				const existing = this.#findToolCall(u.toolCallId);
				if (existing) {
					if (u.status) existing.status = u.status;
					if (u.title) existing.title = u.title;
					if (u.locations && u.locations.length > 0)
						existing.locations = u.locations.map((l) => l.path);
					// A status-only update (very common — "in_progress" arrives on its own)
					// carries no content at all; keep whatever diff/preview an earlier update on
					// this same id already captured rather than clearing it.
					const { diffPatch, preview } = summarizeToolContent(u.content);
					if (diffPatch !== null) existing.diffPatch = diffPatch;
					if (preview !== null) existing.preview = preview;
					const item: TimelineItem = {
						kind: "tool",
						id: existing.id,
						call: existing,
					};
					const seq = this.#seqById.get(existing.id);
					if (seq !== undefined) this.#persistTimelineItem(seq, item);
					this.#emit({ type: "timeline", item });
				}
				break;
			}
			case "plan": {
				this.view.plan = u.entries.map((e) => ({
					content: e.content,
					status: e.status,
					priority: e.priority,
				}));
				this.#emit({ type: "plan", entries: this.view.plan });
				break;
			}
			case "current_mode_update": {
				this.view.modeId = u.currentModeId;
				this.#emit({ type: "config", modeId: u.currentModeId });
				break;
			}
			default:
				break;
		}
	}
}

/**
 * Pulls the two things worth showing out of a tool call's `content`: the unified diff
 * for an edit, and a short preview of a read/search/shell result. Both come back null
 * when the update carries neither — the common case for a bare status change.
 */
function summarizeToolContent(content?: ToolCallContentItem[]): {
	diffPatch: string | null;
	preview: string | null;
} {
	if (!content || content.length === 0)
		return { diffPatch: null, preview: null };

	let diffPatch: string | null = null;
	let preview: string | null = null;
	const PREVIEW_LIMIT = 800;

	for (const item of content) {
		if (item.type === "diff" && diffPatch === null) {
			diffPatch = unifiedDiff(item.oldText ?? "", item.newText, {
				path: item.path,
			});
		} else if (
			item.type === "content" &&
			item.content.type === "text" &&
			preview === null
		) {
			preview = item.content.text.slice(0, PREVIEW_LIMIT);
		}
	}
	return { diffPatch, preview };
}

export class SessionManager {
	#sessions = new Map<string, Session>();

	constructor(
		private readonly deps: {
			store: Store;
			engine: RenderEngine;
			watcher?: WatchManager;
			workDir: string;
			port: () => number;
		},
	) {}

	list(): SessionView[] {
		return [...this.#sessions.values()].map((s) => s.view);
	}

	get(id: string): Session | undefined {
		return this.#sessions.get(id);
	}

	/**
	 * Rebuild every persisted chat into a (stopped) `Session` on startup, so it shows in
	 * the UI and can be reopened. No agent process is spawned here — that waits for an
	 * explicit `resume()`, so a boot with ten old chats does not fork ten CLIs.
	 */
	restoreAll(): void {
		for (const row of this.deps.store.sessions()) {
			if (this.#sessions.has(row.id)) continue;
			const layout = this.deps.store.layoutDetails({
				layoutId: row.layoutId,
			})[0];
			if (!layout) continue; // layout deleted out from under it; its row will cascade away
			const timeline = this.deps.store
				.sessionTimeline(row.id)
				.map((t) => t.item as TimelineItem);
			const session = new Session(
				row.id,
				layout,
				{
					store: this.deps.store,
					engine: this.deps.engine,
					watcher: this.deps.watcher,
					workDir: this.deps.workDir,
					providerId: row.providerId,
					providerName: row.providerName,
					command: "", // filled in by resume() from the detected provider
					args: [],
				},
				{
					acpSessionId: row.acpSessionId,
					timeline,
					plan: (row.plan as SessionView["plan"]) ?? [],
					usage: (row.usage as SessionView["usage"]) ?? {},
					configOptions:
						(row.configOptions as SessionView["configOptions"]) ?? [],
					modeId: row.modeId,
					firstPdfPath: row.firstPdfPath,
					latestPdfPath: row.latestPdfPath,
					error: row.error,
				},
			);
			this.#sessions.set(row.id, session);
		}
	}

	/**
	 * Reopen a restored chat: look up its provider afresh (the persisted row only kept the
	 * id/name, not a runnable command) and hand the `Session` a real command + MCP config
	 * to spawn.
	 */
	async resume(id: string): Promise<Session> {
		const session = this.#sessions.get(id);
		if (!session) throw new Error(`Unknown session ${id}`);

		const providers = await detectProviders();
		const provider = providers.find((p) => p.id === session.view.providerId);
		if (!provider?.runnable) {
			throw new Error(
				provider
					? `${provider.name} cannot be started: ${provider.blocked}.`
					: `Provider "${session.view.providerId}" is no longer installed.`,
			);
		}
		session.setSpawn(provider.command, provider.args);
		await session.resume([session.mcpServerConfig(this.deps.port())]);
		return session;
	}

	mcpServers(): Map<string, McpServer> {
		return new Map([...this.#sessions].map(([id, s]) => [id, s.mcp]));
	}

	async create(layoutId: string, providerId: string): Promise<Session> {
		const layout = this.deps.store.layoutDetails({ layoutId })[0];
		if (!layout) throw new Error(`Unknown layout ${layoutId}`);

		const providers = await detectProviders();
		const provider = providers.find((p) => p.id === providerId);
		if (!provider) {
			throw new Error(
				`Provider "${providerId}" is not installed. Found: ${providers.map((p) => p.id).join(", ") || "none"}.`,
			);
		}
		// Installed is not the same as startable: an adapter-based provider needs its
		// launcher to work too. Refusing here beats spawning something that exits 127.
		if (!provider.runnable) {
			const alternatives = providers
				.filter((p) => p.runnable && p.id !== provider.id)
				.map((p) => p.name);
			throw new Error(
				`${provider.name} cannot be started: ${provider.blocked}.` +
					(alternatives.length
						? ` Available instead: ${alternatives.join(", ")}.`
						: ""),
			);
		}

		const id = crypto.randomUUID();
		const session = new Session(id, layout, {
			store: this.deps.store,
			engine: this.deps.engine,
			watcher: this.deps.watcher,
			workDir: this.deps.workDir,
			providerId: provider.id,
			providerName: provider.name,
			command: provider.command,
			args: provider.args,
		});
		this.#sessions.set(id, session);

		await session.start([session.mcpServerConfig(this.deps.port())]);
		return session;
	}

	/** Explicit "delete this chat" — stops the agent and forgets the transcript for good. */
	async destroy(id: string): Promise<void> {
		const s = this.#sessions.get(id);
		if (!s) return;
		await s.stop();
		this.#sessions.delete(id);
		try {
			this.deps.store.deleteSession(id);
		} catch (e) {
			console.error("[sessions] deleteSession failed", e);
		}
	}

	/**
	 * Shutdown: stop every agent process but keep the rows. This is what makes the chats
	 * come back on the next launch — going through `destroy()` here would wipe them.
	 */
	async stopAll(): Promise<void> {
		await Promise.all(
			[...this.#sessions.values()].map((s) => s.stop().catch(() => {})),
		);
	}
}
