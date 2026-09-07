/**
 * One provider integration, via ACP — not four CLI adapters.
 *
 * Keep the abstraction honest: a provider that never gains ACP support would be wrapped
 * behind the same interface rather than leaking its own event schema upward.
 */

export type { AcpClientOptions, AcpEvents } from "./client.ts";
export { AcpClient, AcpError } from "./client.ts";
export type { DetectedProvider, Provider } from "./providers.ts";
export { detectProviders, PROVIDERS } from "./providers.ts";

export type {
	AgentCapabilities,
	ConfigOption,
	ContentBlock,
	InitializeResult,
	McpCapabilities,
	McpServerConfig,
	NewSessionResult,
	PermissionOption,
	PermissionRequest,
	PlanEntry,
	PromptCapabilities,
	PromptResult,
	SessionMode,
	SessionModes,
	SessionUpdate,
	StopReason,
	ToolCallContentItem,
	ToolCallLocation,
	ToolCallStatus,
	UsageUpdate,
} from "./types.ts";
