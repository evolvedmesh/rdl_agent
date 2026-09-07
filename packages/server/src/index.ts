/**
 * The core process. All the real logic lives here; the UI is a client over localhost.
 *
 * Keeping this boundary is what makes the desktop shell a late-bound decision — the
 * render engine, the ACP client and the MCP server are shell-agnostic, and a browser
 * can drive the whole app during development.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectProviders } from "@layout/acp";
import {
	type ConnectionStatus,
	CredentialsManager,
	connectionLabel,
	defaultSecretStore,
	describeBcError,
	describeBcFailure,
	fakeBcFromEnv,
	fetchReportParameters,
	importLegacyConfig,
	listReportSettings,
	makeFakeBc,
	makeFakeReportParams,
	odataUrl,
	pickFile,
	RenderEngine,
	type SecretStore,
	Store,
	TokenCache,
	WatchManager,
} from "@layout/core";
import { mcpHttpHandler } from "@layout/mcp";
import { type SessionEvent, SessionManager } from "./sessions.ts";

export type {
	PendingPermission,
	SessionEvent,
	SessionStatus,
	SessionView,
	TimelineItem,
	ToolCallView,
} from "./sessions.ts";
export { Session, SessionManager } from "./sessions.ts";

export type AppOptions = {
	dataDir?: string;
	port?: number;
	/**
	 * Where the shared client secret lives. Defaults to the OS keychain — which is why
	 * tests must pass a MemorySecretStore rather than letting it find the real one.
	 */
	secretStore?: SecretStore;
};

const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "layout-agent");

export type App = Awaited<ReturnType<typeof createApp>>;

export async function createApp(opts: AppOptions = {}) {
	const dataDir =
		opts.dataDir ?? process.env.LAYOUT_DATA_DIR ?? DEFAULT_DATA_DIR;
	await mkdir(dataDir, { recursive: true });

	const store = new Store(join(dataDir, "layout.db"));
	const secrets =
		opts.secretStore ?? (await defaultSecretStore(join(dataDir, "secret")));
	const credentials = new CredentialsManager(store, secrets);

	const creds = (await credentials.load()) ?? {
		clientId: "",
		clientSecret: "",
		scope: "https://api.businesscentral.dynamics.com/.default",
		grantType: "client_credentials",
	};
	const tokens = new TokenCache(creds);

	// Replay mode keeps the whole app runnable with no tenant, no secret and no load on
	// anyone's environment — the same fixture path the tests use.
	const fake = fakeBcFromEnv();
	const engine = new RenderEngine(
		store,
		tokens,
		dataDir,
		fake ? makeFakeBc(fake) : undefined,
	);

	// The parameter reads are not part of the render engine — they are one-shot reads —
	// but they honour the same replay switch, so nothing here reaches a tenant in replay
	// mode just because someone pressed a button.
	const bcParams = fake
		? makeFakeReportParams(fake)
		: { listReportSettings, fetchReportParameters };

	const watcher = new WatchManager((e) => console.error("[watch]", e));
	for (const l of store.layouts()) watcher.register(l.id, l.filePath);

	// A human saving in VS Code should refresh the preview without being asked.
	watcher.on(async (e) => {
		for (const layoutId of e.layoutIds) {
			const detail = store.layoutDetails({ layoutId })[0];
			if (detail) await engine.render(detail);
		}
	});

	const sessions = new SessionManager({
		store,
		engine,
		watcher,
		workDir: dataDir,
		// No shim file to locate: the running process is its own MCP shim (see
		// Session.mcpServerConfig — it re-execs `<this> mcp-shim …`).
		port: () => server.port ?? 0,
	});

	const sockets = new Set<Bun.ServerWebSocket<{ sessionId?: string }>>();
	const broadcast = (msg: unknown) => {
		const payload = JSON.stringify(msg);
		for (const ws of sockets) {
			try {
				ws.send(payload);
			} catch {
				/* a dead socket is dropped on close */
			}
		}
	};

	engine.on((e) =>
		broadcast({ channel: "render", event: e, queues: engine.queues() }),
	);

	const attachSession = (sessionId: string) => {
		const s = sessions.get(sessionId);
		s?.on((event: SessionEvent) =>
			broadcast({ channel: "session", sessionId, event }),
		);
	};

	// Rebuild every persisted chat so it shows in the sidebar and can be reopened. No agent
	// process starts here — that waits for an explicit resume.
	sessions.restoreAll();
	for (const v of sessions.list()) attachSession(v.id);

	// A live lookup, not a one-time snapshot: see the comment on mcpHttpHandler for why
	// passing `sessions.mcpServers()` here (the Map itself, captured once, at startup,
	// before any session existed) made every agent's layout_* tools unreachable forever.
	const mcpHttp = mcpHttpHandler(() => sessions.mcpServers());

	const json = (data: unknown, status = 200) => Response.json(data, { status });
	const fail = (e: unknown, status = 400) =>
		Response.json(
			{ error: e instanceof Error ? e.message : String(e) },
			{ status },
		);

	const server = Bun.serve<{ sessionId?: string }>({
		port: opts.port ?? Number(process.env.LAYOUT_PORT ?? 0),
		idleTimeout: 120,

		websocket: {
			open(ws) {
				sockets.add(ws);
				ws.send(JSON.stringify({ channel: "hello", queues: engine.queues() }));
			},
			close(ws) {
				sockets.delete(ws);
			},
			message() {
				/* the socket is a one-way event stream; commands go over REST */
			},
		},

		async fetch(req, srv) {
			const url = new URL(req.url);
			const path = url.pathname;

			if (path === "/ws") {
				return srv.upgrade(req, { data: {} })
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}

			try {
				// --- reads ---------------------------------------------------------
				if (req.method === "GET" && path === "/api/state") {
					return json({
						reports: store.reports().map((r) => {
							const layouts = store.layoutDetails({ reportId: r.id });
							return {
								...r,
								layoutCount: layouts.length,
								clientCount: new Set(layouts.map((l) => l.clientId)).size,
								health: summariseHealth(layouts),
							};
						}),
						clients: store.clients(),
						connections: store.connections(),
						layouts: store.layoutDetails(),
						queues: engine.queues(),
						stats: store.renderStats(),
						sessions: sessions.list(),
					});
				}

				if (req.method === "GET" && path === "/api/providers") {
					return json(await detectProviders());
				}

				if (req.method === "GET" && path === "/api/credentials") {
					return json(await credentials.status());
				}

				if (req.method === "GET" && path === "/api/layouts") {
					const reportId = url.searchParams.get("reportId") ?? undefined;
					const clientId = url.searchParams.get("clientId") ?? undefined;
					return json(store.layoutDetails({ reportId, clientId }));
				}

				if (req.method === "GET" && path.startsWith("/api/renders/")) {
					return json(store.renders(path.slice("/api/renders/".length)));
				}

				// Serving the PDF from the engine's own path is what keeps the human and the
				// agent looking at the same bytes.
				if (req.method === "GET" && path.startsWith("/api/pdf/")) {
					const layoutId = path.slice("/api/pdf/".length);
					const pdf =
						engine.state(layoutId).currentPdf ??
						store.lastRender(layoutId)?.pdfPath;
					if (!pdf) return new Response("no render yet", { status: 404 });
					const file = Bun.file(pdf);
					if (!(await file.exists()))
						return new Response("render file missing", { status: 404 });
					return new Response(file, {
						headers: { "Content-Type": "application/pdf" },
					});
				}

				// GPUIX's <img> loads from the filesystem, not over HTTP, and the UI shares this
				// process — so the desktop shell asks for the raster's path and real pixel size
				// rather than fetching bytes it would only have to write out again.
				if (req.method === "GET" && path.startsWith("/api/page-path/")) {
					const layoutId = path.slice("/api/page-path/".length);
					const page = Number(url.searchParams.get("page") ?? 1);
					const dpi = Number(url.searchParams.get("dpi") ?? 110);
					const pdf =
						engine.state(layoutId).currentPdf ??
						store.lastRender(layoutId)?.pdfPath;
					if (!pdf) return new Response("no render yet", { status: 404 });
					const { pageImage } = await import("@layout/feedback");
					const img = await pageImage(pdf, `${dataDir}/raster/${layoutId}`, {
						page,
						dpi,
						trim: false,
					});
					return json({
						path: img.path,
						widthPx: img.widthPx,
						heightPx: img.heightPx,
						dpi: img.dpi,
					});
				}

				if (req.method === "GET" && path.startsWith("/api/page/")) {
					const [, , , layoutId] = path.split("/");
					if (!layoutId)
						return new Response("missing layout id", { status: 400 });
					const page = Number(url.searchParams.get("page") ?? 1);
					const dpi = Number(url.searchParams.get("dpi") ?? 110);
					const pdf =
						engine.state(layoutId).currentPdf ??
						store.lastRender(layoutId)?.pdfPath;
					if (!pdf) return new Response("no render yet", { status: 404 });
					const { pageImage } = await import("@layout/feedback");
					const img = await pageImage(pdf, `${dataDir}/raster/${layoutId}`, {
						page,
						dpi,
						trim: false,
					});
					return new Response(Bun.file(img.path), {
						headers: { "Content-Type": "image/png" },
					});
				}

				// --- writes --------------------------------------------------------
				if (req.method === "POST" && path === "/api/render") {
					const { layoutId, force } = (await req.json()) as {
						layoutId: string;
						force?: boolean;
					};
					const detail = store.layoutDetails({ layoutId })[0];
					if (!detail)
						return fail(new Error(`Unknown layout ${layoutId}`), 404);
					const result = await engine.render(detail, { force });
					return json(
						result.ok
							? result
							: { ...result, message: describeBcError(result.error) },
					);
				}

				if (req.method === "POST" && path === "/api/clients") {
					const { name } = (await req.json()) as { name: string };
					return json(store.createClient(name));
				}

				if (req.method === "POST" && path === "/api/connections") {
					const body = (await req.json()) as Parameters<
						Store["createConnection"]
					>[0];
					return json(store.createConnection(body));
				}

				if (req.method === "POST" && path === "/api/connections/test") {
					const { connectionId } = (await req.json()) as {
						connectionId: string;
					};
					return json(await testConnection(connectionId));
				}

				if (req.method === "POST" && path === "/api/reports") {
					const { reportId, name, source } = (await req.json()) as {
						reportId: number;
						name: string;
						source?: string;
					};
					return json(store.upsertReport(reportId, name, source ?? null));
				}

				if (req.method === "POST" && path === "/api/layouts") {
					const body = (await req.json()) as Parameters<
						Store["createLayout"]
					>[0];
					const layout = store.createLayout(body);
					watcher.register(layout.id, layout.filePath);
					return json(layout);
				}

				// The core gesture: "Acme wants Hawks' invoice layout" becomes a real file.
				if (req.method === "POST" && path === "/api/layouts/duplicate") {
					const { layoutId, clientId, connectionId, targetPath } =
						(await req.json()) as {
							layoutId: string;
							clientId: string;
							connectionId?: string;
							targetPath: string;
						};
					const source = store.layoutDetails({ layoutId })[0];
					if (!source)
						return fail(new Error(`Unknown layout ${layoutId}`), 404);
					await mkdir(join(targetPath, ".."), { recursive: true }).catch(
						() => {},
					);
					await Bun.write(targetPath, Bun.file(source.filePath));
					const copy = store.createLayout({
						reportId: source.reportId,
						clientId,
						connectionId: connectionId ?? null,
						kind: source.kind,
						filePath: targetPath,
						paramsXml: source.paramsXml,
					});
					watcher.register(copy.id, copy.filePath);
					return json(copy);
				}

				/**
				 * Unbinds a layout: the row, its render history (cascaded) and its file watch.
				 *
				 * The file on disk is deliberately left alone. It belongs to the user, it is
				 * usually inside an AL project under version control, and "remove this from the
				 * app" is a different intention from "delete my work".
				 */
				if (req.method === "DELETE" && path.startsWith("/api/layouts/")) {
					const layoutId = path.slice("/api/layouts/".length);
					const layout = store.layout(layoutId);
					if (!layout)
						return fail(new Error(`Unknown layout ${layoutId}`), 404);

					// An agent still running against it would keep writing to a layout that no
					// longer exists, so it goes first.
					for (const view of sessions.list()) {
						if (view.layoutId === layoutId) await sessions.destroy(view.id);
					}
					watcher.unregister(layoutId);
					store.deleteLayout(layoutId);
					return json({ ok: true, filePath: layout.filePath });
				}

				if (req.method === "PATCH" && path.startsWith("/api/layouts/")) {
					const layoutId = path.slice("/api/layouts/".length);
					const patch = (await req.json()) as {
						connectionId?: string | null;
						paramsXml?: string;
						filePath?: string;
					};
					store.updateLayout(layoutId, patch);
					if (patch.filePath) watcher.register(layoutId, patch.filePath);
					return json(store.layoutDetails({ layoutId })[0]);
				}

				/**
				 * The two reads behind "Fetch from BC" on the preview-parameters field.
				 *
				 * Both answer 200 with `{ ok: false, message }` when Business Central refuses,
				 * rather than an HTTP error: "nobody has saved settings for this report yet" is
				 * an ordinary answer the field shows inline, not a broken request.
				 */
				if (req.method === "POST" && path === "/api/report-settings") {
					const { connectionId, reportId } = (await req.json()) as {
						connectionId: string;
						reportId: number;
					};
					const conn = store.connection(connectionId);
					if (!conn)
						return fail(new Error(`Unknown connection ${connectionId}`), 404);
					const result = await bcParams.listReportSettings(tokens, {
						connection: conn,
						reportId,
					});
					return json(
						result.ok
							? { ok: true, settings: result.settings }
							: { ok: false, message: describeBcFailure(result.error) },
					);
				}

				// The response carries customer data — document numbers, G/L accounts, dates.
				// It goes to the field that asked for it and is never logged on the way.
				if (req.method === "POST" && path === "/api/report-params") {
					const { connectionId, reportId, settingsName } =
						(await req.json()) as {
							connectionId: string;
							reportId: number;
							settingsName?: string;
						};
					const conn = store.connection(connectionId);
					if (!conn)
						return fail(new Error(`Unknown connection ${connectionId}`), 404);
					const result = await bcParams.fetchReportParameters(tokens, {
						connection: conn,
						reportId,
						settingsName,
					});
					return json(
						result.ok
							? {
									ok: true,
									paramsXml: result.paramsXml,
									settingsName: result.settingsName,
								}
							: { ok: false, message: describeBcFailure(result.error) },
					);
				}

				/**
				 * The native file chooser, opened on the machine core runs on.
				 *
				 * There is no timeout on the dialog, so this request is open for as long as the
				 * person is choosing. A caller that gives up should fall back to the typed path
				 * rather than treating it as an error — the field never stops accepting one.
				 */
				if (req.method === "POST" && path === "/api/pick-file") {
					const { startDir, title } = (await req.json()) as {
						startDir?: string;
						title?: string;
					};
					return json(await pickFile({ startDir, title }));
				}

				if (req.method === "POST" && path === "/api/credentials") {
					const { clientId, clientSecret, scope, grantType } =
						(await req.json()) as {
							clientId: string;
							clientSecret?: string;
							scope: string;
							grantType: string;
						};
					store.setCredentialsMeta(clientId, scope, grantType);
					// Write-only: a secret can be set and tested, never read back out.
					if (clientSecret) await credentials.setSecret(clientSecret);
					return json(await credentials.status());
				}

				if (req.method === "POST" && path === "/api/import-legacy") {
					const body = (await req.json()) as Parameters<
						typeof importLegacyConfig
					>[1];
					const result = await importLegacyConfig(store, body);
					if (result.clientSecret) {
						await credentials.setSecret(result.clientSecret);
						result.clientSecret = null;
					}
					for (const l of store.layouts()) watcher.register(l.id, l.filePath);
					return json(result);
				}

				// --- sessions ------------------------------------------------------
				if (req.method === "POST" && path === "/api/sessions") {
					const { layoutId, providerId } = (await req.json()) as {
						layoutId: string;
						providerId: string;
					};
					const session = await sessions.create(layoutId, providerId);
					attachSession(session.id);
					return json(session.view);
				}

				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/prompt$/)
				) {
					const id = path.split("/")[3] ?? "";
					const { message } = (await req.json()) as { message: string };
					const s = sessions.get(id);
					if (!s) return fail(new Error("unknown session"), 404);
					void s.prompt(message);
					return json({ ok: true });
				}

				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/permission$/)
				) {
					const id = path.split("/")[3] ?? "";
					const { optionId } = (await req.json()) as {
						optionId: string | null;
					};
					sessions.get(id)?.resolvePermission(optionId);
					return json({ ok: true });
				}

				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/cancel$/)
				) {
					await sessions.get(path.split("/")[3] ?? "")?.cancel();
					return json({ ok: true });
				}

				// Reopen a chat restored from a previous run: spawn the agent again and, when
				// the provider supports it, session/load the ACP context back.
				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/resume$/)
				) {
					const id = path.split("/")[3] ?? "";
					if (!sessions.get(id)) return fail(new Error("unknown session"), 404);
					const s = await sessions.resume(id);
					return json(s.view);
				}

				// The permission-mode and model pickers. What either one is allowed to be sent
				// comes from the session's own `configOptions` — the client only ever offers
				// values the connected agent itself advertised.
				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/mode$/)
				) {
					const id = path.split("/")[3] ?? "";
					const { modeId } = (await req.json()) as { modeId: string };
					const s = sessions.get(id);
					if (!s) return fail(new Error("unknown session"), 404);
					await s.setMode(modeId);
					return json({ ok: true });
				}

				if (
					req.method === "POST" &&
					path.match(/^\/api\/sessions\/[^/]+\/model$/)
				) {
					const id = path.split("/")[3] ?? "";
					const { modelId } = (await req.json()) as { modelId: string };
					const s = sessions.get(id);
					if (!s) return fail(new Error("unknown session"), 404);
					await s.setModel(modelId);
					return json({ ok: true });
				}

				if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
					await sessions.destroy(path.slice("/api/sessions/".length));
					return json({ ok: true });
				}

				// --- MCP over localhost HTTP ---------------------------------------
				if (path.startsWith("/mcp/")) {
					return mcpHttp(req, path.slice("/mcp/".length));
				}

				return new Response("Not found", { status: 404 });
			} catch (e) {
				return fail(e, 500);
			}
		},
	});

	/**
	 * A real connection test: fetch a token, then make a trivial OData call, and report the
	 * specific failure. "Not consented" and "not registered in BC" are different problems
	 * with different fixes, and a user should not have to discover which through a 401.
	 */
	async function testConnection(
		connectionId: string,
	): Promise<{ status: ConnectionStatus; detail: string; label: string }> {
		const conn = store.connection(connectionId);
		if (!conn) throw new Error(`Unknown connection ${connectionId}`);
		const label = connectionLabel(conn);

		const loaded = await credentials.load();
		if (!loaded) {
			return {
				status: "unknown",
				detail:
					"No credentials configured. Set the client ID and secret in Settings.",
				label,
			};
		}

		const cache = new TokenCache(loaded);
		let token: string;
		try {
			token = await cache.get(conn.tenantId);
		} catch (e) {
			const detail = e instanceof Error ? e.message : String(e);
			const status: ConnectionStatus =
				/consent|not found in the directory|700016/i.test(detail)
					? "unconsented"
					: "forbidden";
			store.setConnectionStatus(conn.id, status);
			return { status, detail, label };
		}

		try {
			const res = await fetch(odataUrl(conn, "Company"), {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				store.setConnectionStatus(conn.id, "ok");
				return {
					status: "ok",
					detail: "Token acquired and the OData endpoint answered.",
					label,
				};
			}
			const body = (await res.text()).slice(0, 400);
			const status: ConnectionStatus =
				res.status === 401 || res.status === 403
					? "not_registered"
					: "forbidden";
			store.setConnectionStatus(conn.id, status);
			return {
				status,
				detail:
					status === "not_registered"
						? `HTTP ${res.status}. The token is valid, so the app is consented — but it is probably not registered on BC's "Microsoft Entra Applications" page for this tenant, or has no permission sets. ${body}`
						: `HTTP ${res.status}. ${body}`,
				label,
			};
		} catch (e) {
			store.setConnectionStatus(conn.id, "unreachable");
			return {
				status: "unreachable",
				detail: e instanceof Error ? e.message : String(e),
				label,
			};
		}
	}

	const shutdown = async () => {
		watcher.close();
		await sessions.stopAll();
		server.stop();
		store.close();
	};

	return {
		server,
		store,
		engine,
		watcher,
		sessions,
		credentials,
		dataDir,
		testConnection,
		shutdown,
		replaying: fake !== undefined,
	};
}

function summariseHealth(
	layouts: { lastRender: { ok: boolean } | null }[],
): "ok" | "failed" | "mixed" | "never" {
	const rendered = layouts.filter((l) => l.lastRender !== null);
	if (rendered.length === 0) return "never";
	const ok = rendered.filter((l) => l.lastRender?.ok).length;
	if (ok === rendered.length) return "ok";
	return ok === 0 ? "failed" : "mixed";
}

if (import.meta.main) {
	const app = await createApp();
	console.log(`layout-agent listening on http://localhost:${app.server.port}`);
	console.log(`  data: ${app.dataDir}`);
	if (app.replaying)
		console.log(`  *** REPLAY MODE — not calling Business Central ***`);
	process.on("SIGINT", async () => {
		await app.shutdown();
		process.exit(0);
	});
}
