import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MemorySecretStore,
	RenderEngine,
	Store,
	TokenCache,
	WatchManager,
} from "@layout/core";
import { type App, createApp, Session } from "@layout/server";

const FIXTURE_PDF = join(import.meta.dir, "fixtures", "preview.pdf");
const FIXTURE_RDL = join(import.meta.dir, "fixtures", "Default.rdl");
const tmp = () => mkdtempSync(join(tmpdir(), "layout-srv-"));

describe("loopback authorisation", () => {
	let app: App;
	let base: string;

	beforeAll(async () => {
		app = await createApp({
			dataDir: tmp(),
			port: 0,
			secretStore: new MemorySecretStore(),
		});
		base = `http://127.0.0.1:${app.server.port}`;
	});

	afterAll(async () => {
		await app.shutdown();
	});

	test("a token is minted by default and demanded on everything with authority", async () => {
		expect(app.authToken).toBeTruthy();

		// Binding to loopback is not an authorisation boundary: any other process on the
		// box can reach 127.0.0.1, and this server spawns agents and holds credentials.
		for (const path of ["/api/state", "/api/credentials", "/mcp/whatever"]) {
			expect((await fetch(`${base}${path}`)).status).toBe(401);
		}
		expect(
			(
				await fetch(`${base}/api/state`, {
					headers: { Authorization: "Bearer wrong" },
				})
			).status,
		).toBe(401);
	});

	test("the token is accepted as a bearer header or a query parameter", async () => {
		const t = app.authToken;
		expect(
			(
				await fetch(`${base}/api/state`, {
					headers: { Authorization: `Bearer ${t}` },
				})
			).status,
		).toBe(200);

		// Query form exists because an <img src> and a WebSocket cannot set headers.
		expect((await fetch(`${base}/api/state?t=${t}`)).status).toBe(200);
	});

	test("static UI assets stay reachable — the document loads before it has a token", async () => {
		// Nothing secret is served from the UI directory, and a 401 here would mean the
		// window could never present a token in the first place.
		expect((await fetch(`${base}/index.html`)).status).not.toBe(401);
	});
});

describe("watch manager", () => {
	test("debounces, dedupes on content hash, and suppresses during agent writes", async () => {
		const dir = tmp();
		const file = join(dir, "Default.rdl");
		await Bun.write(file, "<Report>a</Report>");

		// Short debounce so the test asserts the property without waiting out the 3s default.
		const w = new WatchManager(undefined, { debounceMs: 80 });
		const events: string[] = [];
		w.on((e) => events.push(e.contentHash));
		w.register("layout-1", file);
		await Bun.sleep(120); // let the watch arm before writing

		// Several writes of the SAME bytes must collapse to at most one event.
		await Bun.write(file, "<Report>b</Report>");
		await Bun.write(file, "<Report>b</Report>");
		await Bun.sleep(500);
		const afterSameBytes = events.length;
		expect(afterSameBytes).toBeLessThanOrEqual(1);

		// While suppressed, a real change must produce nothing: the agent renders explicitly.
		const release = w.suppress("layout-1");
		await Bun.write(file, "<Report>c</Report>");
		await Bun.sleep(500);
		expect(events.length).toBe(afterSameBytes);
		release();

		await Bun.write(file, "<Report>d</Report>");
		await Bun.sleep(500);
		expect(events.length).toBeGreaterThan(afterSameBytes);

		w.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("shares one watcher per directory across layouts", async () => {
		const dir = tmp();
		await Bun.write(join(dir, "a.rdl"), "<a/>");
		await Bun.write(join(dir, "b.rdl"), "<b/>");
		const w = new WatchManager();
		w.register("a", join(dir, "a.rdl"));
		w.register("b", join(dir, "b.rdl"));
		expect(w.watchedRoots()).toHaveLength(1);
		w.unregister("a");
		expect(w.watchedRoots()).toHaveLength(1); // still needed by b
		w.unregister("b");
		expect(w.watchedRoots()).toHaveLength(0);
		w.close();
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * Two explicit `layout_render` calls can overlap, each holding its own suppression on
	 * the same layout. Releasing the first must not lift the second's — a Set-based
	 * suppress (rather than a refcount) got exactly this wrong, letting a concurrent edit
	 * slip through mid-render.
	 */
	test("suppress nests: releasing an inner suppression leaves an outer one in effect", async () => {
		const dir = tmp();
		const file = join(dir, "Default.rdl");
		await Bun.write(file, "<Report>a</Report>");

		const w = new WatchManager(undefined, { debounceMs: 80 });
		const events: string[] = [];
		w.on((e) => events.push(e.contentHash));
		w.register("layout-1", file);
		await Bun.sleep(120);

		const releaseOuter = w.suppress("layout-1"); // one render call
		const releaseInner = w.suppress("layout-1"); // a second, overlapping render call
		expect(w.isSuppressed("layout-1")).toBe(true);

		releaseInner(); // the second render finishes; the first has not
		expect(w.isSuppressed("layout-1")).toBe(true);

		await Bun.write(file, "<Report>b</Report>");
		await Bun.sleep(300);
		expect(events.length).toBe(0); // still suppressed — the first render is still running

		releaseOuter();
		expect(w.isSuppressed("layout-1")).toBe(false);

		// Calling either release function again must not under-flow the refcount.
		releaseInner();
		releaseOuter();
		expect(w.isSuppressed("layout-1")).toBe(false);

		await Bun.write(file, "<Report>c</Report>");
		await Bun.sleep(300);
		expect(events.length).toBeGreaterThan(0); // suppression fully lifted now

		w.close();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("http api", () => {
	let app: App;
	let base: string;
	let dataDir: string;
	let layoutPath: string;

	beforeAll(async () => {
		dataDir = tmp();
		layoutPath = join(dataDir, "work", "Default.rdl");
		await mkdir(join(dataDir, "work"), { recursive: true });
		await Bun.write(layoutPath, Bun.file(FIXTURE_RDL));

		process.env.RDLA_FAKE_BC = FIXTURE_PDF;
		process.env.RDLA_FAKE_LATENCY_MS = "0";

		// Never the real keychain: defaultSecretStore would find it and leave a test secret
		// in the developer's own keyring under this app's service name.
		app = await createApp({
			dataDir,
			port: 0,
			secretStore: new MemorySecretStore(),
			authToken: null,
		});
		base = `http://127.0.0.1:${app.server.port}`;

		const client = app.store.createClient("Hawks");
		const conn = app.store.createConnection({
			clientId: client.id,
			label: "Dev3",
			tenantId: "t",
			environment: "Dev3",
			company: "HAWKS",
			isDefault: true,
		});
		const report = app.store.upsertReport(61206, "VAT Settlement");
		app.store.createLayout({
			reportId: report.id,
			clientId: client.id,
			connectionId: conn.id,
			kind: "rdl",
			filePath: layoutPath,
			paramsXml: "<ReportParameters/>",
		});
	});

	afterAll(async () => {
		await app.shutdown();
		await rm(dataDir, { recursive: true, force: true });
	});

	const get = async (p: string) => {
		const r = await fetch(`${base}${p}`);
		return {
			status: r.status,
			body: r.headers.get("content-type")?.includes("json")
				? await r.json()
				: r,
		};
	};

	test("replay mode is active, so no tenant is touched", () => {
		expect(app.replaying).toBe(true);
	});

	test("/api/state is one call for the whole UI", async () => {
		const { body } = (await get("/api/state")) as {
			body: Record<string, unknown>;
		};
		expect(Object.keys(body).sort()).toEqual([
			"clients",
			"connections",
			"layouts",
			"queues",
			"reports",
			"sessions",
			"stats",
		]);
		const reports = body.reports as {
			reportId: number;
			clientCount: number;
			health: string;
		}[];
		expect(reports[0]!.reportId).toBe(61206);
		expect(reports[0]!.clientCount).toBe(1);
		expect(reports[0]!.health).toBe("never");
	});

	test("rendering serves a real PDF and a page raster from the same bytes", async () => {
		const layoutId = app.store.layouts()[0]!.id;
		const res = await fetch(`${base}/api/render`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ layoutId, force: true }),
		});
		const result = (await res.json()) as { ok: boolean; pageCount: number };
		expect(result.ok).toBe(true);
		expect(result.pageCount).toBe(1);

		const pdf = await fetch(`${base}/api/pdf/${layoutId}`);
		expect(pdf.headers.get("content-type")).toBe("application/pdf");
		expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(1000);

		const png = await fetch(`${base}/api/page/${layoutId}?page=1&dpi=72`);
		expect(png.headers.get("content-type")).toBe("image/png");

		const state = (await (await fetch(`${base}/api/state`)).json()) as {
			reports: { health: string }[];
		};
		expect(state.reports[0]!.health).toBe("ok");
	});

	test("the test suite never touches the real OS keychain", async () => {
		const status = (await (await fetch(`${base}/api/credentials`)).json()) as {
			store: string;
		};
		expect(status.store).toBe("in-memory (not persisted)");
	});

	test("credentials round-trip without ever returning the secret", async () => {
		await fetch(`${base}/api/credentials`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				clientId: "abc",
				clientSecret: "super-secret",
				scope: "s",
				grantType: "client_credentials",
			}),
		});
		const status = (await (
			await fetch(`${base}/api/credentials`)
		).json()) as Record<string, unknown>;
		expect(status.clientId).toBe("abc");
		expect(status.hasSecret).toBe(true);
		expect(JSON.stringify(status)).not.toContain("super-secret");
	});

	test("duplicating a layout copies the file — the core gesture of the app", async () => {
		const source = app.store.layouts()[0]!;
		const acme = app.store.createClient("Acme Trading");
		const target = join(dataDir, "work", "Acme.rdl");
		const res = await fetch(`${base}/api/layouts/duplicate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				layoutId: source.id,
				clientId: acme.id,
				targetPath: target,
			}),
		});
		expect(res.status).toBe(200);
		expect(await Bun.file(target).exists()).toBe(true);
		expect(app.store.layouts()).toHaveLength(2);
	});

	test("onboarding a client end to end through the API the UI uses", async () => {
		const post = async (path: string, body: unknown) => {
			const r = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(r.status).toBe(200);
			return r.json() as Promise<Record<string, string>>;
		};

		const client = await post("/api/clients", { name: "Globex" });
		const conn = await post("/api/connections", {
			clientId: client.id,
			label: "Production",
			tenantId: "2c85ac3e-8f39-4971-beba-38bf7fefc87f",
			environment: "Production",
			company: "GLOBEX",
			isDefault: true,
		});
		const report = await post("/api/reports", {
			reportId: 1306,
			name: "Standard Sales Invoice",
		});

		const layoutFile = join(dataDir, "work", "Globex.rdl");
		await Bun.write(layoutFile, Bun.file(FIXTURE_RDL));
		const layout = await post("/api/layouts", {
			reportId: report.id,
			clientId: client.id,
			connectionId: conn.id,
			kind: "rdl",
			filePath: layoutFile,
			paramsXml: "<ReportParameters/>",
		});

		// The layout must come back joined and renderable, which is what the UI shows.
		const detail = app.store.layoutDetails({ layoutId: layout.id! })[0]!;
		expect(detail.clientName).toBe("Globex");
		expect(detail.reportNumber).toBe(1306);
		expect(detail.connection?.company).toBe("GLOBEX");

		// And the params must survive a round trip through the editor's PATCH.
		const patched = await fetch(`${base}/api/layouts/${layout.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paramsXml: '<ReportParameters name="edited"/>' }),
		});
		expect(patched.status).toBe(200);
		expect(app.store.layout(layout.id!)?.paramsXml).toContain("edited");
	});

	test("fetching preview parameters lists the settings, then loads one", async () => {
		const conn = app.store.connections()[0]!;
		const post = async (path: string, body: unknown) =>
			(await (
				await fetch(`${base}${path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				})
			).json()) as {
				ok: boolean;
				settings?: { name: string }[];
				paramsXml?: string;
				settingsName?: string;
				message?: string;
			};

		const list = await post("/api/report-settings", {
			connectionId: conn.id,
			reportId: 61206,
		});
		expect(list.ok).toBe(true);
		expect(list.settings!.length).toBeGreaterThan(1);

		const got = await post("/api/report-params", {
			connectionId: conn.id,
			reportId: 61206,
			settingsName: list.settings![1]!.name,
		});
		expect(got.ok).toBe(true);
		expect(got.settingsName).toBe(list.settings![1]!.name);
		// What the field needs: a ReportParameters document for the report that was asked for.
		expect(got.paramsXml).toContain("<ReportParameters");
		expect(got.paramsXml).toContain('id="61206"');
	});

	test("an unknown connection is a 404 on both parameter reads", async () => {
		for (const path of ["/api/report-settings", "/api/report-params"]) {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ connectionId: "nope", reportId: 61206 }),
			});
			expect(res.status).toBe(404);
		}
	});

	test("the file chooser answers over the API, cancel included", async () => {
		const previous = process.env.RDLA_FAKE_PICKER;
		const pick = async () =>
			(await (
				await fetch(`${base}/api/pick-file`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ startDir: dataDir }),
				})
			).json()) as {
				ok: boolean;
				path?: string;
				cancelled?: boolean;
				message?: string;
			};

		try {
			process.env.RDLA_FAKE_PICKER = layoutPath;
			expect(await pick()).toEqual({ ok: true, path: layoutPath });

			// Dismissing the dialog is an outcome the UI ignores, not an error to show.
			process.env.RDLA_FAKE_PICKER = "cancel";
			expect(await pick()).toEqual({ ok: false, cancelled: true });

			process.env.RDLA_FAKE_PICKER = "none";
			const unavailable = await pick();
			expect(unavailable.ok).toBe(false);
			expect(unavailable.message!.toLowerCase()).toContain("type the path");
		} finally {
			if (previous === undefined) delete process.env.RDLA_FAKE_PICKER;
			else process.env.RDLA_FAKE_PICKER = previous;
		}
	});

	test("removing a layout unbinds it but never deletes the file", async () => {
		const file = join(dataDir, "work", "Removable.rdl");
		await Bun.write(file, Bun.file(FIXTURE_RDL));
		const client = app.store.clients()[0]!;
		const report = app.store.reports()[0]!;
		const layout = app.store.createLayout({
			reportId: report.id,
			clientId: client.id,
			connectionId: null,
			kind: "rdl",
			filePath: file,
			paramsXml: null,
		});

		const res = await fetch(`${base}/api/layouts/${layout.id}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { filePath: string }).toEqual({
			ok: true,
			filePath: file,
		});

		expect(app.store.layout(layout.id)).toBeNull();
		// The whole point: the user's working copy is still on disk.
		expect(await Bun.file(file).exists()).toBe(true);

		expect(
			(await fetch(`${base}/api/layouts/${layout.id}`, { method: "DELETE" }))
				.status,
		).toBe(404);
	});

	test("an unknown layout is a 404, not a 500", async () => {
		const res = await fetch(`${base}/api/render`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ layoutId: "nope" }),
		});
		expect(res.status).toBe(404);
	});

	test("the websocket streams render progress", async () => {
		const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
		const seen: string[] = [];
		await new Promise<void>((resolve) => {
			ws.onmessage = (e) => {
				const m = JSON.parse(String(e.data)) as {
					channel: string;
					event?: { type: string };
				};
				seen.push(m.event?.type ?? m.channel);
				if (seen.includes("finished")) resolve();
			};
			ws.onopen = () => {
				void fetch(`${base}/api/render`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						layoutId: app.store.layouts()[0]!.id,
						force: true,
					}),
				});
			};
		});
		expect(seen).toContain("queued");
		expect(seen).toContain("finished");
		ws.close();
	});
});

/**
 * The answer a consultant meets first: the report exists, the connection works, and
 * nobody has saved settings the app registration can read. That is information, not a
 * broken request — so it has to arrive as a 200 carrying BC's own sentence.
 */
describe("when Business Central has no parameters to give", () => {
	let app: App;
	let base: string;
	let dataDir: string;

	beforeAll(async () => {
		dataDir = tmp();
		process.env.RDLA_FAKE_BC = "error:nosettings";
		process.env.RDLA_FAKE_LATENCY_MS = "0";
		app = await createApp({
			dataDir,
			port: 0,
			secretStore: new MemorySecretStore(),
			authToken: null,
		});
		base = `http://127.0.0.1:${app.server.port}`;

		const client = app.store.createClient("Hawks");
		app.store.createConnection({
			clientId: client.id,
			label: "Dev3",
			tenantId: "t",
			environment: "Dev3",
			company: "HAWKS",
			isDefault: true,
		});
	});

	afterAll(async () => {
		await app.shutdown();
		await rm(dataDir, { recursive: true, force: true });
		process.env.RDLA_FAKE_BC = FIXTURE_PDF;
	});

	test("the refusal comes back as BC's own message, not as an HTTP error", async () => {
		const conn = app.store.connections()[0]!;
		const res = await fetch(`${base}/api/report-settings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ connectionId: conn.id, reportId: 61206 }),
		});
		expect(res.status).toBe(200);

		const body = (await res.json()) as { ok: boolean; message: string };
		expect(body.ok).toBe(false);
		expect(body.message).toContain("no saved settings");
		// Not dressed up as a failed render — nothing was being rendered.
		expect(body.message).not.toContain("could not render the layout");
	});
});

describe("mcp shim wiring", () => {
	/**
	 * The agent execs this itself, so a mistake here surfaces as a broken tool call
	 * mid-session rather than a startup error. Worth asserting rather than assuming.
	 */
	test("the shim is spawnable and speaks MCP over stdio", async () => {
		const shim = join(
			import.meta.dir,
			"..",
			"apps",
			"cli",
			"src",
			"mcp-shim.ts",
		);
		expect(await Bun.file(shim).exists()).toBe(true);

		const proc = Bun.spawn(
			[process.execPath, shim, "--stdio", "--session", "no-such-session"],
			{
				env: { ...process.env, LAYOUT_APP_PORT: "1" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		proc.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`,
		);
		await proc.stdin.flush();

		const reader = proc.stdout.getReader();
		const { value } = await reader.read();
		const line = new TextDecoder().decode(value).split("\n")[0]!;
		const msg = JSON.parse(line) as { id: number; error?: { message: string } };

		// The app is not on port 1, so the shim must report that as a JSON-RPC error rather
		// than hanging or dying silently.
		expect(msg.id).toBe(1);
		expect(msg.error?.message).toContain("Cannot reach the layout app");

		proc.stdin.end();
		proc.kill();
	});

	test("it refuses to start without the pieces it needs", async () => {
		const shim = join(
			import.meta.dir,
			"..",
			"apps",
			"cli",
			"src",
			"mcp-shim.ts",
		);
		for (const [args, env] of [
			[["--stdio"], { LAYOUT_APP_PORT: "1" }],
			[["--stdio", "--session", "s"], {}],
		] as const) {
			const proc = Bun.spawn([process.execPath, shim, ...args], {
				env: { ...process.env, LAYOUT_APP_PORT: undefined, ...env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await proc.exited).toBe(2);
		}
	});
});

/**
 * Drives a real `Session` against the fake ACP agent fixture — the same one
 * `test/acp.test.ts` uses at the client level, one layer up here. `Session` is
 * constructed directly rather than through `SessionManager.create()`, because that
 * method resolves providers via `detectProviders()` against real installed CLIs; there
 * is no way to point it at a fixture. Bypassing it is exactly how the ACP client's own
 * tests already work.
 */
describe("agent session (fake ACP agent)", () => {
	const AGENT = join(import.meta.dir, "fixtures", "fake-acp-agent.ts");

	async function makeSession() {
		const dataDir = tmp();
		const store = new Store(join(dataDir, "layout.db"));
		const client = store.createClient("Hawks Middle East");
		const conn = store.createConnection({
			clientId: client.id,
			label: "Dev3",
			tenantId: "t",
			environment: "Dev3",
			company: "HAWKS MIDDLE EAST",
			isDefault: true,
		});
		const report = store.upsertReport(61206, "Calc. and Post VAT Settlement");
		const filePath = join(dataDir, "Default.rdl");
		await Bun.write(filePath, "<Report/>");
		const layout = store.createLayout({
			reportId: report.id,
			clientId: client.id,
			connectionId: conn.id,
			kind: "rdl",
			filePath,
			paramsXml: null,
		});
		const detail = store.layoutDetails({ layoutId: layout.id })[0]!;

		const engine = new RenderEngine(
			store,
			new TokenCache({
				clientId: "c",
				clientSecret: "s",
				scope: "sc",
				grantType: "client_credentials",
			}),
			dataDir,
		);
		const watcher = new WatchManager();
		watcher.register(layout.id, filePath);

		const session = new Session(crypto.randomUUID(), detail, {
			store,
			engine,
			watcher,
			workDir: dataDir,
			providerId: "fake",
			providerName: "Fake Agent",
			command: "bun",
			args: [AGENT],
		});
		return { session, store, watcher, dataDir };
	}

	test("our own tools are auto-allowed even when the title hides their name", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			// Copilot's shape: readable title, real name in rawInput.command.
			await session.prompt("disguised");
			expect(session.view.permission).toBeNull();
			expect(session.view.status).not.toBe("awaiting-permission");

			// Claude's shape: "mcp__layout__layout_lint". The "_" before the tool name is
			// a word character, so a \b-anchored pattern silently fails to match here.
			await session.prompt("prefixed");
			expect(session.view.permission).toBeNull();
			expect(session.view.status).not.toBe("awaiting-permission");
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("a genuine write still stops and asks", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			// The whole point of the policy: loosening tool recognition must not loosen
			// this. An edit to a customer's layout is what a human has to see coming.
			const turn = session.prompt("write");
			await Bun.sleep(300);
			expect(session.view.status).toBe("awaiting-permission");
			expect(session.view.permission?.title).toBe("Write Default.rdl");
			session.resolvePermission("no");
			await turn;
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("streamed reasoning is coalesced into one entry, not one per token", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			await session.prompt("hello");
			const thoughts = session.view.timeline.filter(
				(i) => i.kind === "message" && i.role === "thought",
			);
			// Three chunks arrive; one entry must come out. A live agent produced sixty
			// rows of one word each before this was buffered.
			expect(thoughts).toHaveLength(1);
			expect(thoughts[0]).toMatchObject({
				text: "I should widen the column.",
			});
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("the agent is briefed once, on the first prompt only", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			await session.prompt("widen the User ID column");
			await session.prompt("now make the total row bold");

			// The transcript must show what the human typed, not the briefing — that is
			// framing for the agent, not part of the conversation.
			const said = session.view.timeline
				.filter((i) => i.kind === "message" && i.role === "user")
				.map((i) => (i.kind === "message" ? i.text : ""));
			expect(said).toEqual([
				"widen the User ID column",
				"now make the total row bold",
			]);

			// The fake agent echoes what it received, so the briefing is observable: it
			// rides on the first turn and must not be repeated on the second.
			const agentText = session.view.timeline
				.filter((i) => i.kind === "message" && i.role === "agent")
				.map((i) => (i.kind === "message" ? i.text : ""))
				.join("\n");
			const mentions = agentText.split("layout_render").length - 1;
			expect(mentions).toBeLessThanOrEqual(1);
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("session/new's modes and configOptions land on the view", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			expect(session.view.modeId).toBe("manual");
			const mode = session.view.configOptions.find((o) => o.id === "mode");
			const model = session.view.configOptions.find((o) => o.id === "model");
			expect(mode?.options.map((o) => o.value)).toEqual(["manual", "auto"]);
			expect(model?.currentValue).toBe("fake-small");
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("setMode and setModel round-trip through the agent and update the view", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			await session.setMode("auto");
			expect(session.view.modeId).toBe("auto");

			await session.setModel("fake-big");
			expect(
				session.view.configOptions.find((o) => o.id === "model")?.currentValue,
			).toBe("fake-big");
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	/**
	 * The two things the earlier version of this got wrong, in one test: a tool call's
	 * diff was captured nowhere, and tool calls were rendered as one block after every
	 * message regardless of when they actually happened. This asserts the fix at the
	 * level that matters — the ordered `timeline` a session actually produces, not just
	 * the diff algorithm in isolation.
	 */
	test("timeline holds tool calls and messages in true order, diff included", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		try {
			await session.prompt("please edit it");

			const kinds = session.view.timeline.map((i) =>
				i.kind === "tool"
					? `tool:${i.call.title}`
					: i.kind === "message"
						? i.role
						: "?",
			);
			// The user's own prompt lands first, same as always. What used to be wrong is
			// everything after it: tc-1 (render) and tc-edit both push during the turn, and
			// the agent's own summary message is only flushed once the turn ends — so it must
			// come last. A lumped "all messages, then all tool calls" rendering put the
			// summary message right after the user's, ahead of the tool calls that produced it.
			//
			// The thought sits between the prompt and the first tool call, because reasoning
			// is flushed by whatever ends it — here, the tool call it led to.
			expect(kinds).toEqual([
				"user",
				"thought",
				"tool:layout_render",
				"tool:Edit Default.rdl",
				"agent",
			]);

			const edit = session.view.timeline.find(
				(i): i is Extract<typeof i, { kind: "tool" }> =>
					i.kind === "tool" && i.call.title === "Edit Default.rdl",
			);
			expect(edit?.call.status).toBe("completed");
			expect(edit?.call.locations).toEqual(["Default.rdl"]);
			expect(edit?.call.diffPatch).toContain("--- a/Default.rdl");
			expect(edit?.call.diffPatch).toContain("-INVOICE NO: 12345");
			// The unchanged surrounding lines are context, not additions — the edit removed
			// one line and added nothing, which the diff must say precisely, not "changed".
			expect(edit?.call.diffPatch).not.toContain("+line two");

			const last = session.view.timeline[session.view.timeline.length - 1]!;
			expect(last.kind).toBe("message");
			if (last.kind === "message") expect(last.text).toBe("Looking at it.");
		} finally {
			await session.stop();
			watcher.close();
			store.close();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	/**
	 * Hot reload: an open session must NOT hold the watcher suppressed. The agent edits
	 * with its own Edit tool and often never calls layout_render, so if the watcher were
	 * muted for the session's life the human would stare at a stale page. Suppression is
	 * now scoped to one explicit layout_render call only (covered by the WatchManager
	 * tests above); outside of that window the watcher is free to fire.
	 */
	test("an open session leaves the watcher free to fire on the agent's edits", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		expect(watcher.isSuppressed(session.view.layoutId)).toBe(false); // from construction
		await session.start([]);
		expect(watcher.isSuppressed(session.view.layoutId)).toBe(false); // still, after start

		await session.stop();
		expect(watcher.isSuppressed(session.view.layoutId)).toBe(false);

		watcher.close();
		store.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	/**
	 * The chat survives an app restart: the transcript, plan, cost and render paths are in
	 * the store as the session runs, and a fresh `Session` rebuilt from those rows shows
	 * the whole conversation again — stopped, ready to resume.
	 */
	test("a session persists to the store and rebuilds from it after a restart", async () => {
		const { session, store, watcher, dataDir } = await makeSession();
		await session.start([]);
		await session.prompt("please edit it");
		await session.stop();

		const liveTimelineLen = session.view.timeline.length;
		expect(liveTimelineLen).toBeGreaterThan(0);

		// What a cold start sees: rows written by the session above, nothing in memory.
		const rows = store.sessions();
		expect(rows.map((r) => r.id)).toEqual([session.id]);
		const row = rows[0]!;
		expect(row.acpSessionId).toBe("sess-1"); // from the fake agent's session/new
		const persistedTimeline = store
			.sessionTimeline(session.id)
			.map((t) => t.item);
		expect(persistedTimeline.length).toBe(liveTimelineLen);

		// Rebuild it the way SessionManager.restoreAll would.
		const detail = store.layoutDetails({ layoutId: row.layoutId })[0]!;
		const engine2 = new RenderEngine(
			store,
			new TokenCache({
				clientId: "c",
				clientSecret: "s",
				scope: "sc",
				grantType: "client_credentials",
			}),
			dataDir,
		);
		const restored = new Session(
			session.id,
			detail,
			{
				store,
				engine: engine2,
				watcher,
				workDir: dataDir,
				providerId: row.providerId,
				providerName: row.providerName,
				command: "bun",
				args: [AGENT],
			},
			{
				acpSessionId: row.acpSessionId,
				timeline: persistedTimeline as never,
				plan: (row.plan as never) ?? [],
				usage: (row.usage as never) ?? {},
				configOptions: (row.configOptions as never) ?? [],
				modeId: row.modeId,
				firstPdfPath: row.firstPdfPath,
				latestPdfPath: row.latestPdfPath,
				error: row.error,
			},
		);

		expect(restored.view.status).toBe("stopped");
		expect(restored.view.restored).toBe(true);
		expect(restored.view.timeline.length).toBe(liveTimelineLen);

		// Resume: the fake agent supports session/load, so it comes back live — and the
		// history it replays during the load is ignored, not stacked onto the transcript.
		await restored.resume([]);
		expect(restored.view.status).toBe("idle");
		expect(restored.view.restored).toBe(false);
		expect(restored.view.timeline.length).toBe(liveTimelineLen);

		await restored.stop();
		watcher.close();
		store.close();
		await rm(dataDir, { recursive: true, force: true });
	});
});
