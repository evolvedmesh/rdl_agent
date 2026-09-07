/**
 * Business Central transport: token cache + the PreviewRdl action.
 *
 * The one thing this file exists to get right is the error taxonomy. An RDL that fails
 * to render must come back carrying BC's own message as structured data, because that
 * is the single highest-value signal in the whole system — and the previewer throws it
 * into console.error.
 */
import { odataUrl, tokenUrl } from "./connection.ts";
import type { Credentials } from "./credentials.ts";
import type { Connection } from "./store.ts";

export type BcError =
	| { kind: "auth"; tenantId: string; status: number; detail: string }
	/** Not consented, or the app is not registered on BC's Entra Applications page. */
	| { kind: "consent"; tenantId: string; detail: string }
	| { kind: "throttle"; retryAfterMs: number; detail: string }
	/** The layout itself failed. `bcMessage` is BC's own text — the useful one. */
	| { kind: "render"; bcMessage: string; code?: string }
	| { kind: "network"; detail: string };

export function describeBcError(e: BcError): string {
	switch (e.kind) {
		case "auth":
			return `Authentication failed for tenant ${e.tenantId} (HTTP ${e.status}): ${e.detail}`;
		case "consent":
			return (
				`Tenant ${e.tenantId} has not onboarded this app. Two steps are required in ` +
				`that tenant: (1) admin consent to the multi-tenant app registration, ` +
				`(2) register the client ID on BC's "Microsoft Entra Applications" page with ` +
				`state Enabled and API permission sets. Detail: ${e.detail}`
			);
		case "throttle":
			return `Business Central throttled the request; retry after ${e.retryAfterMs}ms. ${e.detail}`;
		case "render":
			return `Business Central could not render the layout: ${e.bcMessage}`;
		case "network":
			return `Could not reach Business Central: ${e.detail}`;
	}
}

/** Entra error codes that mean "this tenant has not onboarded the app", not "bad secret". */
const CONSENT_CODES = [
	"AADSTS700016", // application not found in the directory
	"AADSTS650051", // no consent for the requested permissions
	"AADSTS65001", //  user or admin has not consented
	"AADSTS900023", // tenant identifier not found
];

export class BcAuthError extends Error {
	constructor(readonly bcError: BcError) {
		super(describeBcError(bcError));
		this.name = "BcAuthError";
	}
}

/**
 * Per-tenant token cache.
 *
 * Four things the original AADOAuthBuilder got wrong, fixed here:
 *  - keyed by tenant (the whole point of a multi-tenant app registration)
 *  - expiry from the response's `expires_in`, not by decoding the JWT (drops jwt-decode)
 *  - concurrent misses collapse: ten layouts for one client cause ONE token call
 *  - throws on failure instead of caching `undefined` forever with no diagnostic
 */
export class TokenCache {
	#tokens = new Map<string, { token: string; expiresAt: number }>();
	#inflight = new Map<string, Promise<string>>();

	constructor(private readonly creds: Credentials) {}

	async get(tenantId: string): Promise<string> {
		const hit = this.#tokens.get(tenantId);
		if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token; // 60s clock skew

		const pending = this.#inflight.get(tenantId);
		if (pending) return pending;

		const p = this.#fetch(tenantId).finally(() =>
			this.#inflight.delete(tenantId),
		);
		this.#inflight.set(tenantId, p);
		return p;
	}

	/** Drop a cached token, e.g. after an unexpected 401 from the resource. */
	invalidate(tenantId: string): void {
		this.#tokens.delete(tenantId);
	}

	async #fetch(tenantId: string): Promise<string> {
		let res: Response;
		try {
			res = await fetch(tokenUrl(tenantId), {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.creds.clientId,
					client_secret: this.creds.clientSecret,
					grant_type: this.creds.grantType,
					scope: this.creds.scope,
				}),
			});
		} catch (e) {
			throw new BcAuthError({ kind: "network", detail: String(e) });
		}

		if (!res.ok) {
			const detail = await res.text();
			const consent = CONSENT_CODES.some((c) => detail.includes(c));
			throw new BcAuthError(
				consent
					? { kind: "consent", tenantId, detail: firstLine(detail) }
					: {
							kind: "auth",
							tenantId,
							status: res.status,
							detail: firstLine(detail),
						},
			);
		}

		const body = (await res.json()) as {
			access_token: string;
			expires_in: number;
		};
		if (!body.access_token) {
			throw new BcAuthError({
				kind: "auth",
				tenantId,
				status: res.status,
				detail: "Token endpoint returned 200 with no access_token",
			});
		}

		this.#tokens.set(tenantId, {
			token: body.access_token,
			expiresAt: Date.now() + body.expires_in * 1000,
		});
		return body.access_token;
	}
}

/** Entra error bodies are long; keep diagnostics useful without dumping a wall of text. */
function firstLine(s: string): string {
	try {
		const j = JSON.parse(s) as { error_description?: string; error?: string };
		if (j.error_description)
			return j.error_description.split("\r\n")[0]?.slice(0, 400) ?? "";
		if (j.error) return String(j.error).slice(0, 400);
	} catch {
		/* not JSON */
	}
	return s.slice(0, 400);
}

/** The formats the AL API accepts. Excel and Custom are rejected server-side. */
export type LayoutFormat = "RDLC" | "Word";

/** Derive the layout format from the file the user owns, rather than asking for it. */
export function layoutFormatFor(filePath: string): LayoutFormat {
	return /\.docx$/i.test(filePath) ? "Word" : "RDLC";
}

export type PreviewRequest = {
	connection: Connection;
	reportId: number;
	reportParamsXml: string;
	layoutBase64: string;
	layoutFormat: LayoutFormat;
	description?: string;
};

/**
 * The published web service is `PINLayoutPreview` (codeunit 60796 "PIN Layout Preview
 * API"), so every public method on it becomes an unbound OData action named
 * `<service>_<method>`.
 */
export const PREVIEW_ACTION = "PINLayoutPreview_PreviewLayout";

/**
 * The action this app replaced, still published on tenants that have not yet taken the
 * new Base Application build.
 *
 * It is RDL-only and names its payload differently, so both the action and the body
 * shape have to change together — which is exactly why the body is built in one place.
 * Set LAYOUT_BC_LEGACY=1 to talk to it. Remove this once every tenant is upgraded.
 */
export const LEGACY_PREVIEW_ACTION = "RdlpApi_PreviewRdl";

export function usingLegacyAction(): boolean {
	return process.env.LAYOUT_BC_LEGACY === "1";
}

export function previewAction(): string {
	return usingLegacyAction() ? LEGACY_PREVIEW_ACTION : PREVIEW_ACTION;
}

/**
 * The request body, separated out so it can be asserted against the AL signature.
 *
 * These keys must match the parameter names of `PreviewLayout` in codeunit 60796
 * character for character — that is how OData binds an unbound action's body onto the
 * method. A rename on either side fails at runtime with an unhelpful message, so
 * selftest.ts checks the two against each other.
 */
export function previewRequestBody(
	req: PreviewRequest,
): Record<string, unknown> {
	const common = {
		reportId: req.reportId,
		description: req.description ?? "Created by layout agent",
		reportParamsXml: req.reportParamsXml,
	};
	if (usingLegacyAction()) {
		// The old action takes no format and names the payload rdlFileAsBase64.
		return { ...common, rdlFileAsBase64: req.layoutBase64 };
	}
	return {
		...common,
		layoutFormat: req.layoutFormat,
		layoutFileAsBase64: req.layoutBase64,
	};
}

/**
 * The other two actions on the same web service: they read the saved request-page
 * settings a user kept in Business Central, which is the only place `reportParamsXml`
 * exists without opening a request page.
 *
 * A service-to-service caller owns no settings of its own, so what comes back is what
 * someone saved with "Share settings with all users" ticked. Page 60799 in the Base
 * Application ("Report Parameters for Layout Preview") is the route for the rest.
 */
export const SETTINGS_ACTION = "PINLayoutPreview_ListReportSettings";
export const PARAMS_ACTION = "PINLayoutPreview_GetReportParameters";

/** One row of `Object Options` as codeunit 60797 describes it. No parameter data. */
export type ReportSetting = {
	name: string;
	user: string;
	company: string;
	/** Saved with "share with all users" — the only kind an app registration can read. */
	shared: boolean;
	/** Written by the platform for a single scheduled run rather than kept by a user. */
	temporary: boolean;
};

export type SettingsRequest = { connection: Connection; reportId: number };
export type SettingsResult =
	| { ok: true; settings: ReportSetting[] }
	| { ok: false; error: BcError };

export type ParamsRequest = {
	connection: Connection;
	reportId: number;
	settingsName?: string;
};
export type ParamsResult =
	| { ok: true; paramsXml: string; settingsName: string }
	| { ok: false; error: BcError };

/**
 * Bodies for the two reads, kept beside `previewRequestBody` for the same reason: the
 * keys are the contract. OData binds an unbound action's body onto the AL method by
 * parameter name, so these must match `ListReportSettings` and `GetReportParameters`
 * in codeunit 60796 character for character.
 */
export function settingsRequestBody(
	req: SettingsRequest,
): Record<string, unknown> {
	return { reportId: req.reportId };
}

export function paramsRequestBody(req: ParamsRequest): Record<string, unknown> {
	// The AL parameter is not optional — OData binds every declared parameter, and an
	// empty name is what means "pick the best match" on the server.
	return { reportId: req.reportId, settingsName: req.settingsName ?? "" };
}

/** Names the settings a caller may read for a report. Carries no parameter data. */
export async function listReportSettings(
	tokens: TokenCache,
	req: SettingsRequest,
): Promise<SettingsResult> {
	const res = await callAction(
		tokens,
		req.connection,
		SETTINGS_ACTION,
		settingsRequestBody(req),
	);
	if (!res.ok) return res;

	const settings = parseReportSettings(res.value);
	if (!settings) {
		return {
			ok: false,
			error: {
				kind: "render",
				bcMessage: `${SETTINGS_ACTION} did not return JSON: ${res.value.slice(0, 200)}`,
			},
		};
	}
	return { ok: true, settings };
}

/**
 * The parameters themselves. `settingsName` empty asks the AL for the best match: the
 * caller's own settings before anyone else's shared ones.
 *
 * Never log the result — it is the customer data this whole file is careful about.
 */
export async function fetchReportParameters(
	tokens: TokenCache,
	req: ParamsRequest,
): Promise<ParamsResult> {
	const res = await callAction(
		tokens,
		req.connection,
		PARAMS_ACTION,
		paramsRequestBody(req),
	);
	if (!res.ok) return res;
	return {
		ok: true,
		paramsXml: res.value,
		settingsName: req.settingsName ?? "",
	};
}

/** Tolerant of a shape change on the AL side: a row missing a field is not a crash. */
export function parseReportSettings(json: string): ReportSetting[] | null {
	let rows: unknown;
	try {
		rows = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;

	return rows
		.filter(
			(r): r is Record<string, unknown> => typeof r === "object" && r !== null,
		)
		.map((r) => ({
			name: String(r.name ?? ""),
			user: String(r.user ?? ""),
			company: String(r.company ?? ""),
			shared: r.shared === true,
			temporary: r.temporary === true,
		}));
}

/**
 * Same taxonomy as `describeBcError`, for the calls that render nothing: a refused
 * action is BC saying no, not a layout that failed, so it reads as BC's own sentence.
 */
export function describeBcFailure(e: BcError): string {
	return e.kind === "render" ? e.bcMessage : describeBcError(e);
}

export type PreviewResult =
	| { ok: true; pdf: Uint8Array; durationMs: number }
	| { ok: false; error: BcError; durationMs: number };

/**
 * POST the layout to the PINLayoutPreview_PreviewLayout AL action and get a PDF back.
 *
 * The action inserts the layout transiently, renders it, and deletes it again, so this
 * leaves nothing behind in the tenant.
 *
 * Never log the request body: reportParamsXml contains customer data (document
 * numbers, G/L accounts, dates), and the Authorization header carries a live token.
 */
export async function previewLayout(
	tokens: TokenCache,
	req: PreviewRequest,
): Promise<PreviewResult> {
	const started = performance.now();
	const done = () => Math.round(performance.now() - started);

	const res = await callAction(
		tokens,
		req.connection,
		previewAction(),
		previewRequestBody(req),
	);
	if (!res.ok) return { ok: false, error: res.error, durationMs: done() };

	// Buffer.from is dramatically faster than the previewer's atob + char-by-char loop,
	// which matters once reports are multi-megabyte.
	const pdf = new Uint8Array(Buffer.from(stripDataUri(res.value), "base64"));
	if (pdf.length < 5 || String.fromCharCode(...pdf.slice(0, 4)) !== "%PDF") {
		return {
			ok: false,
			error: {
				kind: "render",
				bcMessage: "Decoded payload is not a PDF (missing %PDF header)",
			},
			durationMs: done(),
		};
	}

	return { ok: true, pdf, durationMs: done() };
}

type ActionResult = { ok: true; value: string } | { ok: false; error: BcError };

/**
 * POST an unbound OData action and return its `value` string.
 *
 * Every call into the PINLayoutPreview service goes through here, which is what makes
 * the error taxonomy uniform: a tenant that has not taken the Base Application build
 * yet 404s the same way whether the caller wanted a render or a parameters blob, and
 * says so in the same words.
 *
 * Never log the request body: reportParamsXml contains customer data (document
 * numbers, G/L accounts, dates), and the Authorization header carries a live token.
 */
async function callAction(
	tokens: TokenCache,
	connection: Connection,
	action: string,
	body: Record<string, unknown>,
): Promise<ActionResult> {
	let token: string;
	try {
		token = await tokens.get(connection.tenantId);
	} catch (e) {
		if (e instanceof BcAuthError) return { ok: false, error: e.bcError };
		return { ok: false, error: { kind: "network", detail: String(e) } };
	}

	let res: Response;
	try {
		res = await fetch(odataUrl(connection, action), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	} catch (e) {
		return { ok: false, error: { kind: "network", detail: String(e) } };
	}

	if (res.status === 429 || res.status === 503) {
		const retryAfter = Number(res.headers.get("retry-after") ?? "0");
		return {
			ok: false,
			error: {
				kind: "throttle",
				retryAfterMs:
					Number.isFinite(retryAfter) && retryAfter > 0
						? retryAfter * 1000
						: 10_000,
				detail: `HTTP ${res.status}`,
			},
		};
	}

	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}

	// `>= 400`, not the previewer's `> 400` — a plain 400 fell through to the success path.
	if (res.status >= 400) {
		return {
			ok: false,
			error: classifyErrorBody(res, parsed, text, connection, action),
		};
	}

	// A 200 can still carry an OData error object.
	const odataError = (
		parsed as { error?: { code?: string; message?: string } } | undefined
	)?.error;
	if (odataError) {
		return {
			ok: false,
			error: {
				kind: "render",
				bcMessage: odataError.message ?? text.slice(0, 800),
				code: odataError.code,
			},
		};
	}

	const value = (parsed as { value?: string } | undefined)?.value;
	if (typeof value !== "string" || value.length === 0) {
		return {
			ok: false,
			error: {
				kind: "render",
				bcMessage: `Response had no "value" payload: ${text.slice(0, 400)}`,
			},
		};
	}

	return { ok: true, value };
}

function stripDataUri(b64: string): string {
	return b64.startsWith("data:") ? (b64.split(",")[1] ?? b64) : b64;
}

function classifyErrorBody(
	res: Response,
	body: unknown,
	text: string,
	connection: Connection,
	action: string,
): BcError {
	const err = (
		body as { error?: { code?: string; message?: string } } | undefined
	)?.error;
	const message = err?.message ?? text.slice(0, 800);
	const code = err?.code;

	if (res.status === 401 || res.status === 403) {
		// BC returns 401 for "app not registered in Entra Applications" as well as for a
		// genuinely bad token. The message text is the only way to tell them apart.
		const consentish =
			/not (been )?(registered|consented|authorized)|Entra|AAD application/i.test(
				message,
			);
		return consentish
			? { kind: "consent", tenantId: connection.tenantId, detail: message }
			: {
					kind: "auth",
					tenantId: connection.tenantId,
					status: res.status,
					detail: message,
				};
	}

	if (res.status === 404) {
		return {
			kind: "consent",
			tenantId: connection.tenantId,
			detail:
				`The ${action} action was not found on ${connection.environment}. ` +
				`Either the Pinetworks Base Application is not installed in this environment, or ` +
				`its PINLayoutPreview web service is not published. ${message}`,
		};
	}

	return { kind: "render", bcMessage: message, code };
}
