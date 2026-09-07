/**
 * Core: everything the product does that has nothing to do with a UI or an agent.
 * Usable on its own — `apps/cli` renders a layout with only this package.
 */

export type {
	BcError,
	LayoutFormat,
	ParamsRequest,
	ParamsResult,
	PreviewRequest,
	PreviewResult,
	ReportSetting,
	SettingsRequest,
	SettingsResult,
} from "./bc.ts";
export {
	BcAuthError,
	describeBcError,
	describeBcFailure,
	fetchReportParameters,
	LEGACY_PREVIEW_ACTION,
	layoutFormatFor,
	listReportSettings,
	PARAMS_ACTION,
	PREVIEW_ACTION,
	paramsRequestBody,
	parseReportSettings,
	previewAction,
	previewLayout,
	previewRequestBody,
	SETTINGS_ACTION,
	settingsRequestBody,
	TokenCache,
	usingLegacyAction,
} from "./bc.ts";
export { connectionLabel, odataUrl, tokenUrl } from "./connection.ts";
export type { Credentials, SecretStore } from "./credentials.ts";
export {
	CredentialsManager,
	defaultSecretStore,
	FileSecretStore,
	MemorySecretStore,
	SecretToolStore,
	SecurityStore,
} from "./credentials.ts";
export type { FakeBcOptions } from "./fake-bc.ts";
export { fakeBcFromEnv, makeFakeBc, makeFakeReportParams } from "./fake-bc.ts";
export type { ImportResult } from "./import.ts";
export { importLegacyConfig } from "./import.ts";
export type {
	PickerCommand,
	PickRequest,
	PickResult,
	PickVerdict,
} from "./picker.ts";
export { classifyPickOutput, pickerCommand, pickFile } from "./picker.ts";
export type {
	PageMargins,
	QueueSnapshot,
	RenderEvent,
	RenderResult,
	RenderTransport,
} from "./render.ts";
export { pageMarginsFromXml, RenderEngine } from "./render.ts";
export type {
	Client,
	Connection,
	ConnectionStatus,
	Layout,
	LayoutDetail,
	LayoutKind,
	PersistedSession,
	PersistedTimelineItem,
	RenderRow,
	Report,
} from "./store.ts";
export { newId, Store } from "./store.ts";
export type { WatchEvent } from "./watch.ts";
export { WatchManager } from "./watch.ts";
