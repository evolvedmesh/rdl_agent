/**
 * Client for the core process. The UI holds no domain logic of its own — it renders
 * what the server says and posts commands back, which is what lets the same core run
 * behind a browser, this shell, or a different one later.
 */

import type { DetectedProvider } from "@layout/acp";
import type {
	Client,
	Connection,
	LayoutDetail,
	PickResult,
	QueueSnapshot,
	ReportSetting,
} from "@layout/core";
import type { SessionEvent, SessionView } from "@layout/server";

export type ReportCard = {
	id: string;
	reportId: number;
	name: string;
	source: string | null;
	layoutCount: number;
	clientCount: number;
	health: "ok" | "failed" | "mixed" | "never";
};

export type AppState = {
	reports: ReportCard[];
	clients: Client[];
	connections: Connection[];
	layouts: LayoutDetail[];
	queues: QueueSnapshot[];
	stats: {
		count: number;
		okCount: number;
		p50Ms: number | null;
		p95Ms: number | null;
	};
	sessions: SessionView[];
};

export type CredentialStatus = {
	configured: boolean;
	clientId: string | null;
	hasSecret: boolean;
	store: string;
};

export type ServerMessage =
	| { channel: "hello"; queues: QueueSnapshot[] }
	| { channel: "render"; event: unknown; queues: QueueSnapshot[] }
	| { channel: "session"; sessionId: string; event: SessionEvent };

export class Api {
	constructor(readonly base: string) {}

	async #json<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await fetch(`${this.base}${path}`, {
			...init,
			headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(
				`${init?.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`,
			);
		}
		return (await res.json()) as T;
	}

	state = () => this.#json<AppState>("/api/state");
	providers = () => this.#json<DetectedProvider[]>("/api/providers");
	credentials = () => this.#json<CredentialStatus>("/api/credentials");

	render = (layoutId: string, force = false) =>
		this.#json<unknown>("/api/render", {
			method: "POST",
			body: JSON.stringify({ layoutId, force }),
		});

	testConnection = (connectionId: string) =>
		this.#json<{ status: string; detail: string; label: string }>(
			"/api/connections/test",
			{
				method: "POST",
				body: JSON.stringify({ connectionId }),
			},
		);

	saveCredentials = (body: {
		clientId: string;
		clientSecret?: string;
		scope: string;
		grantType: string;
	}) =>
		this.#json<CredentialStatus>("/api/credentials", {
			method: "POST",
			body: JSON.stringify(body),
		});

	updateLayout = (
		layoutId: string,
		patch: { connectionId?: string | null; paramsXml?: string },
	) =>
		this.#json<LayoutDetail>(`/api/layouts/${layoutId}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});

	/**
	 * The saved settings a report has in one tenant, and the parameters of one of them.
	 *
	 * Both answer `{ ok: false, message }` rather than throwing when BC refuses: the
	 * common answer — "nobody has saved settings for this report" — is information the
	 * field shows, not an error the dialog should blow up on.
	 */
	reportSettings = (body: { connectionId: string; reportId: number }) =>
		this.#json<{ ok: boolean; settings?: ReportSetting[]; message?: string }>(
			"/api/report-settings",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		);

	reportParams = (body: {
		connectionId: string;
		reportId: number;
		settingsName?: string;
	}) =>
		this.#json<{
			ok: boolean;
			paramsXml?: string;
			settingsName?: string;
			message?: string;
		}>("/api/report-params", {
			method: "POST",
			body: JSON.stringify(body),
		});

	/**
	 * Opens the desktop's own file chooser in the core process and resolves when the
	 * person is done with it — which may be a while, so callers keep the typed path
	 * usable rather than blocking the form on this.
	 */
	pickFile = (body: { startDir?: string; title?: string } = {}) =>
		this.#json<PickResult>("/api/pick-file", {
			method: "POST",
			body: JSON.stringify(body),
		});

	/** Unbinds the layout. The file on disk is not touched — the server says so back. */
	deleteLayout = (layoutId: string) =>
		this.#json<{ ok: boolean; filePath: string }>(`/api/layouts/${layoutId}`, {
			method: "DELETE",
		});

	duplicateLayout = (body: {
		layoutId: string;
		clientId: string;
		connectionId?: string;
		targetPath: string;
	}) =>
		this.#json<unknown>("/api/layouts/duplicate", {
			method: "POST",
			body: JSON.stringify(body),
		});

	createClient = (name: string) =>
		this.#json<Client>("/api/clients", {
			method: "POST",
			body: JSON.stringify({ name }),
		});

	createConnection = (body: {
		clientId: string;
		label: string;
		tenantId: string;
		environment: string;
		company: string;
		isDefault: boolean;
	}) =>
		this.#json<Connection>("/api/connections", {
			method: "POST",
			body: JSON.stringify(body),
		});

	createReport = (reportId: number, name: string, source?: string) =>
		this.#json<ReportCard>("/api/reports", {
			method: "POST",
			body: JSON.stringify({ reportId, name, source }),
		});

	createLayout = (body: {
		reportId: string;
		clientId: string;
		connectionId: string | null;
		kind: "rdl" | "docx";
		filePath: string;
		paramsXml: string | null;
	}) =>
		this.#json<LayoutDetail>("/api/layouts", {
			method: "POST",
			body: JSON.stringify(body),
		});

	createSession = (layoutId: string, providerId: string) =>
		this.#json<SessionView>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ layoutId, providerId }),
		});

	promptSession = (id: string, message: string) =>
		this.#json<unknown>(`/api/sessions/${id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ message }),
		});

	answerPermission = (id: string, optionId: string | null) =>
		this.#json<unknown>(`/api/sessions/${id}/permission`, {
			method: "POST",
			body: JSON.stringify({ optionId }),
		});

	cancelSession = (id: string) =>
		this.#json<unknown>(`/api/sessions/${id}/cancel`, { method: "POST" });

	/** Reopen a chat that was restored from a previous run. */
	resumeSession = (id: string) =>
		this.#json<SessionView>(`/api/sessions/${id}/resume`, { method: "POST" });

	/** The permission-mode and model pickers. Values come from the session's own `configOptions`. */
	setSessionMode = (id: string, modeId: string) =>
		this.#json<unknown>(`/api/sessions/${id}/mode`, {
			method: "POST",
			body: JSON.stringify({ modeId }),
		});

	setSessionModel = (id: string, modelId: string) =>
		this.#json<unknown>(`/api/sessions/${id}/model`, {
			method: "POST",
			body: JSON.stringify({ modelId }),
		});

	/**
	 * The page raster as a local file path plus its real pixel size.
	 *
	 * Zooming re-requests at a higher DPI rather than scaling a bitmap, so a zoomed page
	 * gains real resolution instead of enlarging pixels.
	 */
	pageRaster = (layoutId: string, page: number, dpi: number) =>
		this.#json<{
			path: string;
			widthPx: number;
			heightPx: number;
			dpi: number;
		}>(`/api/page-path/${layoutId}?page=${page}&dpi=${dpi}`);

	connect(onMessage: (m: ServerMessage) => void): () => void {
		const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/ws`);
		ws.onmessage = (e) => {
			try {
				onMessage(JSON.parse(String(e.data)) as ServerMessage);
			} catch {
				/* ignore malformed frames */
			}
		};
		return () => ws.close();
	}
}
