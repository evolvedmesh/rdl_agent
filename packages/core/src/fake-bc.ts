/**
 * A recorded-response stand-in for Business Central.
 *
 * The plan's testing rule: record real BC responses once and replay them; do not hit a
 * live tenant in CI. This is that replay. It exists so the whole ladder — render, lint,
 * diff, raster, MCP transport — is exercisable end to end with no tenant, no secret and
 * no load on someone's environment, and so every branch of the BcError taxonomy can be
 * provoked on demand instead of only when something goes wrong for real.
 *
 * It is NOT a renderer. It returns a fixture PDF regardless of what the layout says, so
 * it validates the pipeline's mechanics, never the layout's correctness.
 *
 *   RDLA_FAKE_BC=<path-to.pdf>   replay that PDF
 *   RDLA_FAKE_BC=error:throttle  provoke a BcError kind
 *   RDLA_FAKE_LATENCY_MS=2000    simulate the measured BC round trip
 *
 * It also stands in for the two parameter reads, so "Fetch from BC" is clickable with
 * no tenant — including its empty case, which is the one a consultant meets first.
 */
import type {
	BcError,
	ParamsRequest,
	ParamsResult,
	PreviewRequest,
	PreviewResult,
	SettingsRequest,
	SettingsResult,
} from "./bc.ts";
import type { Connection } from "./store.ts";

const ERROR_FIXTURES: Record<string, (conn: Connection) => BcError> = {
	auth: (conn) => ({
		kind: "auth",
		tenantId: conn.tenantId,
		status: 401,
		detail: "AADSTS7000215: Invalid client secret provided.",
	}),
	consent: (conn) => ({
		kind: "consent",
		tenantId: conn.tenantId,
		detail:
			"AADSTS700016: Application with identifier was not found in the directory.",
	}),
	throttle: () => ({
		kind: "throttle",
		retryAfterMs: 10_000,
		detail: "HTTP 429",
	}),
	render: () => ({
		kind: "render",
		// The shape codeunit 60797 "PIN Layout Preview Mgt." produces: its own prefix
		// wrapping the reporting engine's verbatim message. That inner message is the
		// highest-value signal in the system, which is why the AL deliberately does not
		// summarise it away.
		bcMessage:
			"The report could not be rendered with the supplied layout: An error occurred " +
			"during local report processing. The definition of the report 'Report' is invalid. " +
			"The Size property for Body has a negative value. The value must be a positive number.",
		code: "Internal_ReportRenderingError",
	}),
	/** The AL rejects a report ID that is not installed before spending a render. */
	reportmissing: () => ({
		kind: "render",
		bcMessage: "Report 61206 does not exist in this environment.",
		code: "Internal_ServerError",
	}),
	/**
	 * What GetReportParameters says when nobody kept settings for the report — the most
	 * likely answer from a tenant that has never used the capture page, and the case the
	 * UI has to handle gracefully rather than as a failure.
	 */
	nosettings: () => ({
		kind: "render",
		bcMessage:
			"Report 61206 has no saved settings you can read in company CRONUS. Save the " +
			"settings from the report's request page, and share them with all users if an " +
			"application registration is meant to read them.",
		code: "Internal_ServerError",
	}),
	/** Excel and Custom layouts are refused by ParseLayoutFormat. */
	badformat: () => ({
		kind: "render",
		bcMessage: "Unsupported layout format 'Excel'. Use RDLC or Word.",
		code: "Internal_ServerError",
	}),
	network: () => ({
		kind: "network",
		detail: "ConnectionRefused: api.businesscentral.dynamics.com",
	}),
};

export type FakeBcOptions = { fixture: string; latencyMs: number };

export function fakeBcFromEnv(): FakeBcOptions | undefined {
	const fixture = process.env.RDLA_FAKE_BC;
	if (!fixture) return undefined;
	return {
		fixture,
		latencyMs: Number(process.env.RDLA_FAKE_LATENCY_MS ?? 2000),
	};
}

/** Drop-in replacement for previewLayout, matching its signature so RenderEngine cannot tell. */
export function makeFakeBc(opts: FakeBcOptions) {
	return async (
		_tokens: unknown,
		req: PreviewRequest,
	): Promise<PreviewResult> => {
		const started = performance.now();
		// Latency is simulated because it is the loop's rate limiter: a pipeline that feels
		// fine at 0ms can be unusable at the measured ~2s.
		await Bun.sleep(opts.latencyMs);
		const durationMs = Math.round(performance.now() - started);

		if (opts.fixture.startsWith("error:")) {
			const kind = opts.fixture.slice(6);
			const make = ERROR_FIXTURES[kind];
			if (!make)
				throw new Error(
					`Unknown fake BC error kind: ${kind}. Try ${Object.keys(ERROR_FIXTURES).join(", ")}.`,
				);
			return { ok: false, error: make(req.connection), durationMs };
		}

		const file = Bun.file(opts.fixture);
		if (!(await file.exists()))
			throw new Error(`Fake BC fixture not found: ${opts.fixture}`);
		return {
			ok: true,
			pdf: new Uint8Array(await file.arrayBuffer()),
			durationMs,
		};
	};
}

/**
 * The replay half of the parameters fetch.
 *
 * The XML is a shape, not a recording: it has the elements a ReportParameters document
 * has so the UI, the length counter and the store round-trip are all exercised, and it
 * names nothing real — a recorded blob would carry a customer's document numbers into
 * the repository.
 */
export function makeFakeReportParams(opts: FakeBcOptions) {
	const errorFor = (conn: Connection): BcError | undefined => {
		if (!opts.fixture.startsWith("error:")) return undefined;
		const kind = opts.fixture.slice(6);
		const make = ERROR_FIXTURES[kind];
		if (!make)
			throw new Error(
				`Unknown fake BC error kind: ${kind}. Try ${Object.keys(ERROR_FIXTURES).join(", ")}.`,
			);
		return make(conn);
	};

	return {
		async listReportSettings(
			_tokens: unknown,
			req: SettingsRequest,
		): Promise<SettingsResult> {
			await Bun.sleep(opts.latencyMs);
			const error = errorFor(req.connection);
			if (error) return { ok: false, error };
			return { ok: true, settings: fakeSettings(req) };
		},

		async fetchReportParameters(
			_tokens: unknown,
			req: ParamsRequest,
		): Promise<ParamsResult> {
			await Bun.sleep(opts.latencyMs);
			const error = errorFor(req.connection);
			if (error) return { ok: false, error };
			const settingsName =
				req.settingsName || fakeSettings(req)[0]?.name || "Replay settings";
			return { ok: true, paramsXml: fakeParamsXml(req.reportId), settingsName };
		},
	};
}

function fakeSettings(req: SettingsRequest | ParamsRequest) {
	return [
		{
			name: "Replay settings",
			user: "REPLAY",
			company: req.connection.company,
			shared: true,
			temporary: false,
		},
		{
			name: "Month end",
			user: "REPLAY",
			company: req.connection.company,
			shared: true,
			temporary: false,
		},
	];
}

function fakeParamsXml(reportId: number): string {
	return (
		`<?xml version="1.0" standalone="yes"?><ReportParameters name="Replay" id="${reportId}">` +
		`<Options><Field name="ShowDetails">true</Field></Options>` +
		`<DataItems><DataItem name="Item">VERSION(1) SORTING(Field1)</DataItem></DataItems>` +
		`</ReportParameters>`
	);
}
