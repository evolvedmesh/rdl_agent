/**
 * Client for the core process. The UI holds no domain logic of its own — it renders
 * what the server says and posts commands back, which is what lets the same core run
 * behind a browser, this webview, or a different shell later.
 *
 * Origin and token both come from the document's own URL: the main process opens the
 * window at `http://127.0.0.1:<port>/?t=<token>`, so the window starts out holding a
 * credential no other local process was given.
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

export type RenderEvent =
	| { type: "queued"; layoutId: string; connectionId: string; depth: number }
	| { type: "started"; layoutId: string; connectionId: string }
	| {
			type: "finished";
			layoutId: string;
			connectionId: string;
			result: {
				ok: boolean;
				layoutId: string;
				pageCount?: number;
				durationMs: number;
				cached?: boolean;
				error?: { kind: string; message: string };
			};
	  };

export type ServerMessage =
	| { channel: "hello"; queues: QueueSnapshot[] }
	| { channel: "render"; event: RenderEvent; queues: QueueSnapshot[] }
	| { channel: "session"; sessionId: string; event: SessionEvent };

/**
 * The launch token, taken off the URL once and kept for the life of the window.
 *
 * It is removed from the address bar so it is not left on display, and mirrored into
 * sessionStorage so a reload does not lock the window out of its own server.
 * sessionStorage is the right scope: same tab only, gone when the window closes.
 */
const TOKEN_KEY = "layout-agent.token";

function readToken(): string {
	const url = new URL(window.location.href);
	const fromUrl = url.searchParams.get("t");
	if (fromUrl) {
		sessionStorage.setItem(TOKEN_KEY, fromUrl);
		url.searchParams.delete("t");
		window.history.replaceState({}, "", url.toString());
		return fromUrl;
	}
	return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export class Api {
	readonly base = window.location.origin;
	readonly token = readToken();

	async #json<T>(path: string, init?: RequestInit): Promise<T> {
		const res = await fetch(`${this.base}${path}`, {
			...init,
			headers: {
				"Content-Type": "application/json",
				...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
				...(init?.headers ?? {}),
			},
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(
				`${init?.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`,
			);
		}
		return (await res.json()) as T;
	}

	/** For <img src> and anything else that cannot carry a header. */
	url(path: string): string {
		const sep = path.includes("?") ? "&" : "?";
		return `${this.base}${path}${this.token ? `${sep}t=${this.token}` : ""}`;
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
			{ method: "POST", body: JSON.stringify({ connectionId }) },
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
			{ method: "POST", body: JSON.stringify(body) },
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

	destroySession = (id: string) =>
		this.#json<unknown>(`/api/sessions/${id}`, { method: "DELETE" });

	/**
	 * A rendered page as an image URL. The browser decodes it; zooming re-requests at a
	 * higher DPI rather than scaling a bitmap, so a zoomed page gains real resolution.
	 */
	pageUrl = (layoutId: string, page: number, dpi: number) =>
		this.url(`/api/page/${layoutId}?page=${page}&dpi=${dpi}`);

	pdfUrl = (layoutId: string) => this.url(`/api/pdf/${layoutId}`);

	/**
	 * The live half: render progress and agent output. Reconnects with backoff, because
	 * a silently dead socket looks exactly like an app that has stopped working — but a
	 * fixed retry against a server that is refusing us just spams the console forever.
	 */
	connect(onMessage: (m: ServerMessage) => void): () => void {
		let ws: WebSocket | null = null;
		let closed = false;
		let attempt = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;

		const open = () => {
			if (closed) return;
			const wsBase = this.base.replace(/^http/, "ws");
			ws = new WebSocket(`${wsBase}/ws${this.token ? `?t=${this.token}` : ""}`);
			ws.onopen = () => {
				attempt = 0;
			};
			ws.onmessage = (e) => {
				try {
					onMessage(JSON.parse(String(e.data)) as ServerMessage);
				} catch {
					/* a malformed frame is not worth tearing the socket down for */
				}
			};
			ws.onclose = () => {
				if (closed) return;
				attempt += 1;
				retry = setTimeout(open, Math.min(1000 * 2 ** (attempt - 1), 30_000));
			};
		};
		open();

		return () => {
			closed = true;
			if (retry) clearTimeout(retry);
			ws?.close();
		};
	}
}
