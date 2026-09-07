/**
 * One-time import of the original single-tenant previewer config, so an existing setup
 * survives the move to a multi-client store. Mapping is report-projects.md §9.
 */
import { odataUrl } from "./connection.ts";
import type { Store } from "./store.ts";

export type ImportResult = {
	clientId: string;
	connectionId: string;
	reportId: string;
	layoutId: string;
	/** The secret is returned, never stored here — the caller puts it in the keychain. */
	clientSecret: string | null;
	warnings: string[];
};

type ConfidentialJson = {
	bcClientId: string;
	bcClientSecret: string;
	bcClientScope: string;
	bcClientGrantType: string;
};

type PreviewJson = {
	reportId: number;
	bcTenantId: string;
	previewRdlApiFullUrl: string;
	reportParamsXml: string;
};

/** The legacy config stores the URL expanded; take the connection parts back out of it. */
export function parseLegacyUrl(url: string): {
	environment: string;
	company: string;
} {
	const u = new URL(url);
	const parts = u.pathname.split("/").filter(Boolean);
	const odataIdx = parts.indexOf("ODataV4");
	if (odataIdx < 1)
		throw new Error(`Cannot parse environment from URL path: ${u.pathname}`);
	const environment = parts[odataIdx - 1];
	if (!environment)
		throw new Error(`Cannot parse environment from URL path: ${u.pathname}`);
	const raw = u.searchParams.get("company");
	if (!raw) throw new Error("Legacy URL has no ?company= parameter");
	return {
		environment,
		company: raw.replace(/^'|'$/g, "").replaceAll("''", "'"),
	};
}

export async function importLegacyConfig(
	store: Store,
	opts: {
		previewConfigPath: string;
		confidentialPath?: string;
		layoutPath: string;
		clientName: string;
		reportName?: string;
	},
): Promise<ImportResult> {
	const warnings: string[] = [];
	const preview = (await Bun.file(
		opts.previewConfigPath,
	).json()) as PreviewJson;
	const { environment, company } = parseLegacyUrl(preview.previewRdlApiFullUrl);

	let clientSecret: string | null = null;
	if (
		opts.confidentialPath &&
		(await Bun.file(opts.confidentialPath).exists())
	) {
		const conf = (await Bun.file(
			opts.confidentialPath,
		).json()) as ConfidentialJson;
		store.setCredentialsMeta(
			conf.bcClientId,
			conf.bcClientScope,
			conf.bcClientGrantType,
		);
		clientSecret = conf.bcClientSecret;
		warnings.push(
			`The client secret was read from ${opts.confidentialPath}. Put it in the keychain and delete that file — one secret unlocks every client tenant.`,
		);
	}

	const client = store.createClient(opts.clientName);
	const connection = store.createConnection({
		clientId: client.id,
		label: environment,
		tenantId: preview.bcTenantId,
		environment,
		company,
		isDefault: true,
	});
	const report = store.upsertReport(
		preview.reportId,
		opts.reportName ?? `Report ${preview.reportId}`,
	);
	const layout = store.createLayout({
		reportId: report.id,
		clientId: client.id,
		connectionId: connection.id,
		kind: opts.layoutPath.toLowerCase().endsWith(".docx") ? "docx" : "rdl",
		filePath: opts.layoutPath,
		paramsXml: preview.reportParamsXml,
	});

	if (!(await Bun.file(opts.layoutPath).exists())) {
		warnings.push(`Layout file does not exist yet: ${opts.layoutPath}`);
	}

	return {
		clientId: client.id,
		connectionId: connection.id,
		reportId: report.id,
		layoutId: layout.id,
		clientSecret,
		warnings,
	};
}

/** Exported for tests and for the Settings "test connection" preview. */
export { odataUrl };
