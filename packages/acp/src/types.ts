/**
 * Agent Client Protocol types — the subset this app actually uses.
 *
 * The reason there is one client and not four CLI adapters: every provider we care
 * about already speaks ACP, and it carries streaming output, permission prompts,
 * session resume, MCP server attachment and image content blocks. Writing per-provider
 * adapters would mean four schemas, four permission models and four sets of flags that
 * change between releases.
 */

export type ProtocolVersion = number;

export type PromptCapabilities = {
	image?: boolean;
	audio?: boolean;
	embeddedContext?: boolean;
};

export type McpCapabilities = {
	http?: boolean;
	sse?: boolean;
};

export type AgentCapabilities = {
	loadSession?: boolean;
	promptCapabilities?: PromptCapabilities;
	mcpCapabilities?: McpCapabilities;
};

export type InitializeResult = {
	protocolVersion: ProtocolVersion;
	agentCapabilities?: AgentCapabilities;
	authMethods?: { id: string; name?: string; description?: string }[];
};

export type McpServerConfig = {
	name: string;
	command: string;
	args?: string[];
	env?: { name: string; value: string }[];
};

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource_link"; uri: string; name?: string }
	| { type: "resource"; resource: Record<string, unknown> };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type PlanEntry = {
	content: string;
	priority?: "high" | "medium" | "low";
	status?: "pending" | "in_progress" | "completed";
};

/**
 * What a `tool_call`/`tool_call_update`'s `content` array actually carries on the wire —
 * captured from a live Claude Code and opencode session, not from spec memory. It is
 * NOT `ContentBlock[]`: an edit reports as `{type:"diff", path, oldText, newText}`, and a
 * read or shell result reports as `{type:"content", content: ContentBlock}`. Reading this
 * as bare `ContentBlock`s (the earlier version of this type) silently drops both — which
 * is why an edit's diff never reached the UI.
 */
export type ToolCallContentItem =
	| { type: "content"; content: ContentBlock }
	| { type: "diff"; path: string; oldText: string | null; newText: string }
	| { type: "terminal"; terminalId: string };

export type ToolCallLocation = { path: string; line?: number };

/**
 * `session/update` is the UI. Streaming text, a live tool-call list, the agent's plan and
 * a running token count all arrive here, standardised across providers.
 */
export type SessionUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
	| { sessionUpdate: "user_message_chunk"; content: ContentBlock }
	| {
			sessionUpdate: "tool_call";
			toolCallId: string;
			title?: string;
			kind?: string;
			status?: ToolCallStatus;
			rawInput?: unknown;
			content?: ToolCallContentItem[];
			locations?: ToolCallLocation[];
	  }
	| {
			sessionUpdate: "tool_call_update";
			toolCallId: string;
			status?: ToolCallStatus;
			title?: string;
			content?: ToolCallContentItem[];
			locations?: ToolCallLocation[];
			rawOutput?: unknown;
	  }
	| { sessionUpdate: "plan"; entries: PlanEntry[] }
	| { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
	| { sessionUpdate: "current_mode_update"; currentModeId: string };

export type UsageUpdate = {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	totalTokens?: number;
	costUsd?: number;
};

export type PermissionOption = {
	optionId: string;
	name: string;
	kind:
		| "allow_once"
		| "allow_always"
		| "reject_once"
		| "reject_always"
		| string;
};

export type PermissionRequest = {
	sessionId: string;
	toolCall: {
		toolCallId: string;
		title?: string;
		kind?: string;
		rawInput?: unknown;
	};
	options: PermissionOption[];
};

export type StopReason =
	| "end_turn"
	| "max_tokens"
	| "max_turn_requests"
	| "refusal"
	| "cancelled";

export type PromptResult = { stopReason: StopReason };

/**
 * The generic "adjustable setting" shape both Claude Code's adapter and opencode return
 * from `session/new` — confirmed on the wire from both, not documented in the ACP core
 * spec. `id` is what to match on: every provider tested uses `"mode"` for its permission
 * mode and `"model"` for the model picker, which is what makes one UI control work for
 * both rather than needing a per-provider switch.
 */
export type ConfigOption = {
	id: string;
	name: string;
	description?: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options: { value: string; name: string; description?: string }[];
};

export type SessionMode = { id: string; name: string; description?: string };
export type SessionModes = {
	currentModeId: string;
	availableModes: SessionMode[];
};

/**
 * `session/new`'s full response. `sessionId` is the only field the ACP core spec
 * guarantees; `modes` and `configOptions` are present on both providers this app has
 * actually talked to, so both are captured rather than only the bare id.
 */
export type NewSessionResult = {
	sessionId: string;
	modes?: SessionModes;
	configOptions?: ConfigOption[];
};
