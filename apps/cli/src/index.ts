#!/usr/bin/env bun
/**
 * Headless entry point. Renders a layout with only @layout/core — no UI, no agent —
 * which is the check that the package boundaries actually hold.
 *
 *   layout render --client hawks --report 61206
 *   layout list
 *   layout import --preview <path> --confidential <path> --layout <path> --client "Hawks"
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	CredentialsManager,
	connectionLabel,
	defaultSecretStore,
	describeBcError,
	fakeBcFromEnv,
	importLegacyConfig,
	makeFakeBc,
	odataUrl,
	RenderEngine,
	Store,
	TokenCache,
} from "@layout/core";
import { formatFindings } from "@layout/feedback";

const DATA_DIR =
	process.env.LAYOUT_DATA_DIR ??
	join(homedir(), ".local", "share", "layout-agent");

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? undefined : process.argv[i + 1];
}

const command = process.argv[2];
const store = new Store(join(DATA_DIR, "layout.db"));

async function engineFor(): Promise<RenderEngine> {
	const secrets = await defaultSecretStore(join(DATA_DIR, "secret"));
	const creds = (await new CredentialsManager(store, secrets).load()) ?? {
		clientId: "",
		clientSecret: "",
		scope: "https://api.businesscentral.dynamics.com/.default",
		grantType: "client_credentials",
	};
	const fake = fakeBcFromEnv();
	if (fake) console.error(`  (replay mode: ${fake.fixture})`);
	return new RenderEngine(
		store,
		new TokenCache(creds),
		DATA_DIR,
		fake ? makeFakeBc(fake) : undefined,
	);
}

switch (command) {
	case "list": {
		const rows = store.layoutDetails();
		if (rows.length === 0) {
			console.log("No layouts yet. Use `layout import` or add one in the app.");
			break;
		}
		for (const r of rows) {
			const health = r.lastRender
				? r.lastRender.ok
					? `ok ${r.lastRender.durationMs}ms`
					: "FAILED"
				: "never rendered";
			console.log(
				`${String(r.reportNumber).padEnd(8)} ${r.clientName.padEnd(24)} ${r.kind.padEnd(5)} ` +
					`${(r.connection ? connectionLabel(r.connection) : "no connection").padEnd(34)} ${health}`,
			);
		}
		break;
	}

	case "render": {
		const clientName = flag("client");
		const reportNumber = flag("report");
		const rows = store
			.layoutDetails()
			.filter(
				(r) =>
					(!clientName ||
						r.clientName.toLowerCase().includes(clientName.toLowerCase())) &&
					(!reportNumber || String(r.reportNumber) === reportNumber),
			);
		if (rows.length === 0) {
			console.error("No layout matched. Try `layout list`.");
			process.exit(1);
		}
		const engine = await engineFor();
		for (const row of rows) {
			const result = await engine.render(row, {
				force: process.argv.includes("--force"),
			});
			if (result.ok) {
				console.log(
					`OK   ${row.reportNumber} ${row.clientName}  ${result.pageCount} page(s)  ` +
						`${result.durationMs}ms${result.cached ? " (cached)" : ""}  ->  ${result.pdfPath}`,
				);
				if (result.lint.length) console.log(formatFindings(result.lint));
			} else {
				console.error(
					`FAIL ${row.reportNumber} ${row.clientName}: ${describeBcError(result.error)}`,
				);
				process.exitCode = 1;
			}
		}
		break;
	}

	case "import": {
		const previewConfigPath = flag("preview");
		const layoutPath = flag("layout");
		const clientName = flag("client");
		if (!previewConfigPath || !layoutPath || !clientName) {
			console.error(
				"usage: layout import --preview <json> --layout <rdl> --client <name> [--confidential <json>] [--report-name <name>]",
			);
			process.exit(2);
		}
		const result = await importLegacyConfig(store, {
			previewConfigPath,
			confidentialPath: flag("confidential"),
			layoutPath,
			clientName,
			reportName: flag("report-name"),
		});
		if (result.clientSecret) {
			const secrets = await defaultSecretStore(join(DATA_DIR, "secret"));
			await new CredentialsManager(store, secrets).setSecret(
				result.clientSecret,
			);
			console.log("Client secret moved into the OS keychain.");
		}
		for (const w of result.warnings) console.warn(`warning: ${w}`);
		console.log(`Imported. Layout ${result.layoutId}`);
		break;
	}

	/**
	 * Set up a client, its connection, a report and a layout in one go.
	 *
	 * This is the "add a client" flow the UI does not have yet. Everything it writes is
	 * ordinary store state, so the app picks it up on next launch with no import step.
	 */
	case "onboard": {
		const name = flag("client");
		const tenant = flag("tenant");
		const environment = flag("environment");
		const company = flag("company");
		const layoutPath = flag("layout");
		const reportNumber = Number(flag("report"));

		if (
			!name ||
			!tenant ||
			!environment ||
			!company ||
			!layoutPath ||
			!reportNumber
		) {
			console.error(
				[
					"usage: layout onboard --client <name> --tenant <guid> --environment <env>",
					"                      --company <company> --report <number> --layout <file>",
					"                      [--report-name <name>] [--params <file-with-reportParamsXml>]",
					"",
					"Company must match Business Central exactly, including case and spacing —",
					"it goes into the OData URL as a string literal.",
				].join("\n"),
			);
			process.exit(2);
		}

		if (!(await Bun.file(layoutPath).exists())) {
			console.error(`Layout file not found: ${layoutPath}`);
			process.exit(2);
		}

		const paramsFile = flag("params");
		const paramsXml = paramsFile ? await Bun.file(paramsFile).text() : null;
		if (!paramsXml) {
			console.warn(
				"warning: no --params given. BC needs reportParamsXml to render; capture it from the\n" +
					"         report's request page and pass it with --params, or edit the layout later.",
			);
		}

		const client = store.createClient(name);
		const connection = store.createConnection({
			clientId: client.id,
			label: environment,
			tenantId: tenant,
			environment,
			company,
			isDefault: true,
		});
		const report = store.upsertReport(
			reportNumber,
			flag("report-name") ?? `Report ${reportNumber}`,
		);
		const layout = store.createLayout({
			reportId: report.id,
			clientId: client.id,
			connectionId: connection.id,
			kind: layoutPath.toLowerCase().endsWith(".docx") ? "docx" : "rdl",
			filePath: resolve(layoutPath),
			paramsXml,
		});

		console.log(`Client       ${client.name}`);
		console.log(
			`Connection   ${connectionLabel(connection)}  (tenant ${tenant})`,
		);
		console.log(`Report       ${report.reportId} ${report.name}`);
		console.log(`Layout       ${layout.filePath}`);
		console.log("");
		console.log("Next: set the shared credentials, then test the connection:");
		console.log(
			"  bun apps/cli/src/index.ts credentials --client-id <guid> --secret-stdin",
		);
		console.log("  bun apps/cli/src/index.ts test-connection");
		break;
	}

	/** The shared Entra app registration. The secret goes to the keychain, nowhere else. */
	case "credentials": {
		const appClientId = flag("client-id");
		if (!appClientId) {
			console.error(
				"usage: layout credentials --client-id <guid> [--scope <scope>] --secret-stdin",
			);
			process.exit(2);
		}

		let secret: string | undefined;
		if (process.argv.includes("--secret-stdin")) {
			// Read from stdin rather than argv: a secret on the command line lands in shell
			// history and in the process list, and this one unlocks every client tenant.
			secret = (await Bun.stdin.text()).trim();
			if (!secret) {
				console.error("No secret received on stdin.");
				process.exit(2);
			}
		}

		const scope =
			flag("scope") ?? "https://api.businesscentral.dynamics.com/.default";
		store.setCredentialsMeta(appClientId, scope, "client_credentials");

		const manager = new CredentialsManager(
			store,
			await defaultSecretStore(join(DATA_DIR, "secret")),
		);
		if (secret) await manager.setSecret(secret);

		const status = await manager.status();
		console.log(`client ID    ${status.clientId}`);
		console.log(`scope        ${scope}`);
		console.log(
			`secret       ${status.hasSecret ? "stored" : "NOT SET — pass --secret-stdin"}`,
		);
		console.log(`store        ${status.store}`);
		break;
	}

	/**
	 * A real check: fetch a token, then call BC. Consent and BC registration are separate
	 * steps in the customer's tenant and fail identically with a bare 401, so this says
	 * which one is missing.
	 */
	case "test-connection": {
		const manager = new CredentialsManager(
			store,
			await defaultSecretStore(join(DATA_DIR, "secret")),
		);
		const creds = await manager.load();
		if (!creds) {
			console.error(
				"No credentials configured. Run `layout credentials` first.",
			);
			process.exit(2);
		}

		const wanted = flag("client");
		const conns = store.connections().filter((c) => {
			if (!wanted) return true;
			return store
				.client(c.clientId)
				?.name.toLowerCase()
				.includes(wanted.toLowerCase());
		});
		if (conns.length === 0) {
			console.error("No connections configured. Run `layout onboard` first.");
			process.exit(2);
		}

		const cache = new TokenCache(creds);
		for (const conn of conns) {
			const who = `${store.client(conn.clientId)?.name ?? "?"}  ${connectionLabel(conn)}`;
			try {
				const token = await cache.get(conn.tenantId);
				const res = await fetch(odataUrl(conn, "Company"), {
					headers: { Authorization: `Bearer ${token}` },
				});
				if (res.ok) {
					store.setConnectionStatus(conn.id, "ok");
					console.log(`OK        ${who}`);
				} else {
					const body = (await res.text()).slice(0, 300);
					store.setConnectionStatus(
						conn.id,
						res.status === 401 || res.status === 403
							? "not_registered"
							: "forbidden",
					);
					console.error(`FAIL      ${who}`);
					console.error(
						res.status === 401 || res.status === 403
							? `          HTTP ${res.status} — the token is valid, so consent is granted, but the app is\n` +
									`          probably not registered on BC's "Microsoft Entra Applications" page in this\n` +
									`          tenant, or has no permission sets. ${body}`
							: `          HTTP ${res.status}. ${body}`,
					);
					process.exitCode = 1;
				}
			} catch (e) {
				const detail = e instanceof Error ? e.message : String(e);
				const unconsented = /consent|not found in the directory|700016/i.test(
					detail,
				);
				store.setConnectionStatus(
					conn.id,
					unconsented ? "unconsented" : "unreachable",
				);
				console.error(`FAIL      ${who}`);
				console.error(
					unconsented
						? `          The tenant has not granted admin consent to this app registration yet.\n          ${detail}`
						: `          ${detail}`,
				);
				process.exitCode = 1;
			}
		}
		break;
	}

	case "stats": {
		const s = store.renderStats();
		console.log(
			`renders: ${s.count}  ok: ${s.okCount}  p50: ${s.p50Ms ?? "-"}ms  p95: ${s.p95Ms ?? "-"}ms`,
		);
		break;
	}

	default:
		console.log(
			[
				"layout <command>",
				"",
				"  onboard --client <name> --tenant <guid> --environment <env> --company <co>",
				"          --report <number> --layout <file> [--report-name <n>] [--params <file>]",
				"  credentials --client-id <guid> --secret-stdin",
				"  test-connection [--client <name>]",
				"",
				"  list                       every client × report layout, with last-render health",
				"  render --client <name> --report <number> [--force]",
				"  import --preview <json> --layout <rdl> --client <name> [--confidential <json>]",
				"  stats                      accumulated BC render latency",
			].join("\n"),
		);
}

store.close();
