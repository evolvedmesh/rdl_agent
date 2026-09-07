import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeFakeBc,
	odataUrl,
	RenderEngine,
	Store,
	TokenCache,
} from "@layout/core";

const FIXTURE_PDF = join(import.meta.dir, "fixtures", "preview.pdf");
const FIXTURE_RDL = join(import.meta.dir, "fixtures", "Default.rdl");
const tmp = () => mkdtempSync(join(tmpdir(), "layout-test-"));

function seed(store: Store, layoutPath = FIXTURE_RDL) {
	const client = store.createClient("Hawks Middle East");
	const conn = store.createConnection({
		clientId: client.id,
		label: "Dev3",
		tenantId: "tenant-1",
		environment: "Dev3",
		company: "HAWKS MIDDLE EAST",
		isDefault: true,
	});
	const report = store.upsertReport(61206, "Calc. and Post VAT Settlement");
	const layout = store.createLayout({
		reportId: report.id,
		clientId: client.id,
		connectionId: conn.id,
		kind: "rdl",
		filePath: layoutPath,
		paramsXml: "<ReportParameters/>",
	});
	return { client, conn, report, layout };
}

describe("store", () => {
	test("migrates from empty and is idempotent", () => {
		const path = join(tmp(), "a.db");
		new Store(path).close();
		const s = new Store(path); // second open must not re-run migrations
		expect(s.reports()).toEqual([]);
		s.close();
	});

	test("layoutDetails joins client, report, connection and last render in one query", () => {
		const s = new Store(":memory:");
		const { layout } = seed(s);
		s.recordRender({
			layoutId: layout.id,
			contentHash: "abc",
			pdfPath: "/x.pdf",
			ok: true,
			error: null,
			durationMs: 2100,
		});
		const [d] = s.layoutDetails();
		expect(d!.clientName).toBe("Hawks Middle East");
		expect(d!.reportNumber).toBe(61206);
		expect(d!.connection?.environment).toBe("Dev3");
		expect(d!.lastRender?.durationMs).toBe(2100);
		s.close();
	});

	test("a report number is unique, so importing twice does not duplicate", () => {
		const s = new Store(":memory:");
		const a = s.upsertReport(61206, "VAT");
		const b = s.upsertReport(61206, "VAT again");
		expect(b.id).toBe(a.id);
		expect(s.reports()).toHaveLength(1);
		s.close();
	});

	test("deleting a client cascades to its layouts", () => {
		const s = new Store(":memory:");
		const { client } = seed(s);
		expect(s.layouts()).toHaveLength(1);
		s.db.query("DELETE FROM client WHERE id = ?").run(client.id);
		expect(s.layouts()).toHaveLength(0);
		s.close();
	});

	test("render stats accumulate the BC latency answer", () => {
		const s = new Store(":memory:");
		const { layout } = seed(s);
		for (const ms of [1000, 2000, 3000, 9000]) {
			s.recordRender({
				layoutId: layout.id,
				contentHash: `h${ms}`,
				pdfPath: null,
				ok: true,
				error: null,
				durationMs: ms,
			});
		}
		const stats = s.renderStats();
		expect(stats.okCount).toBe(4);
		expect(stats.p50Ms).toBeGreaterThanOrEqual(2000);
		expect(stats.p95Ms).toBeLessThanOrEqual(9000);
		s.close();
	});

	test("agent chats persist: session row plus an ordered, rewritable timeline", () => {
		const s = new Store(":memory:");
		const { layout } = seed(s);

		s.upsertSession({
			id: "sess-1",
			layoutId: layout.id,
			providerId: "claude",
			providerName: "Claude Code",
			acpSessionId: null,
			status: "thinking",
			modeId: "manual",
			configOptions: [{ id: "mode", name: "Mode", options: [] }],
			usage: { totalTokens: 10 },
			plan: [],
			firstPdfPath: null,
			latestPdfPath: null,
			error: null,
		});
		s.appendTimelineItem("sess-1", 0, {
			kind: "message",
			id: "m0",
			role: "user",
		});
		s.appendTimelineItem("sess-1", 1, {
			kind: "tool",
			id: "t1",
			call: { status: "pending" },
		});
		// Re-using seq 1 rewrites that entry rather than appending a duplicate.
		s.appendTimelineItem("sess-1", 1, {
			kind: "tool",
			id: "t1",
			call: { status: "completed" },
		});

		// A later write with the same id updates in place; created_at is kept.
		s.upsertSession({
			id: "sess-1",
			layoutId: layout.id,
			providerId: "claude",
			providerName: "Claude Code",
			acpSessionId: "acp-42",
			status: "idle",
			modeId: "manual",
			configOptions: [],
			usage: { totalTokens: 99 },
			plan: [],
			firstPdfPath: "/first.pdf",
			latestPdfPath: "/latest.pdf",
			error: null,
		});

		const row = s.session("sess-1")!;
		expect(row.acpSessionId).toBe("acp-42");
		expect(row.status).toBe("idle");
		expect((row.usage as { totalTokens: number }).totalTokens).toBe(99);
		expect(row.latestPdfPath).toBe("/latest.pdf");
		expect(s.sessions().map((r) => r.id)).toEqual(["sess-1"]);

		const timeline = s.sessionTimeline("sess-1");
		expect(timeline.map((t) => t.seq)).toEqual([0, 1]);
		expect(
			(timeline[1]!.item as { call: { status: string } }).call.status,
		).toBe("completed");

		// Deleting the session cascades its timeline; deleting the layout cascades the session.
		s.deleteSession("sess-1");
		expect(s.sessions()).toEqual([]);
		expect(s.sessionTimeline("sess-1")).toEqual([]);
		s.close();
	});

	test("deleting a layout cascades to its agent chats", () => {
		const s = new Store(":memory:");
		const { layout } = seed(s);
		s.upsertSession({
			id: "sess-x",
			layoutId: layout.id,
			providerId: "p",
			providerName: "P",
			acpSessionId: null,
			status: "idle",
			modeId: null,
			configOptions: [],
			usage: {},
			plan: [],
			firstPdfPath: null,
			latestPdfPath: null,
			error: null,
		});
		s.appendTimelineItem("sess-x", 0, {
			kind: "message",
			id: "m",
			role: "user",
		});
		s.deleteLayout(layout.id);
		expect(s.sessions()).toEqual([]);
		expect(s.sessionTimeline("sess-x")).toEqual([]);
		s.close();
	});

	test("the secret is never written to the database", () => {
		const s = new Store(":memory:");
		s.setCredentialsMeta("client-id-123", "scope", "client_credentials");
		const cols = s.db
			.query<{ name: string }, []>("PRAGMA table_info(credentials)")
			.all()
			.map((c) => c.name);
		expect(cols).not.toContain("secret");
		expect(cols).not.toContain("client_secret");
		s.close();
	});
});

describe("odata url", () => {
	test("doubles apostrophes and URI-encodes", () => {
		const u = odataUrl(
			{ tenantId: "t", environment: "Dev3", company: "O'Brien & Sons" },
			"X",
		);
		expect(new URL(u).searchParams.get("company")).toBe("'O''Brien & Sons'");
	});
});

describe("render engine", () => {
	const engineFor = (store: Store, workDir: string, fixture = FIXTURE_PDF) =>
		new RenderEngine(
			store,
			new TokenCache({
				clientId: "c",
				clientSecret: "s",
				scope: "sc",
				grantType: "client_credentials",
			}),
			workDir,
			makeFakeBc({ fixture, latencyMs: 0 }),
		);

	test("renders, records the row, and dedupes unchanged bytes", async () => {
		const s = new Store(":memory:");
		seed(s);
		const engine = engineFor(s, tmp());
		const [detail] = s.layoutDetails();

		const first = await engine.render(detail!);
		expect(first.ok).toBe(true);
		if (first.ok) {
			expect(first.cached).toBe(false);
			expect(first.pageCount).toBe(1);
		}
		expect(s.renders(detail!.id)).toHaveLength(1);

		const second = await engine.render(detail!);
		expect(second.ok && second.cached).toBe(true);
		// A cache hit is not a BC round trip, so it must not add a render row.
		expect(s.renders(detail!.id)).toHaveLength(1);
		s.close();
	});

	test("a missing connection fails before touching the network", async () => {
		const s = new Store(":memory:");
		const { layout } = seed(s);
		s.updateLayout(layout.id, { connectionId: null });
		const engine = engineFor(s, tmp());
		const r = await engine.render(s.layoutDetails()[0]!);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.detail).toContain("no connection assigned");
		s.close();
	});

	test("a BC failure records a structured error and marks the connection", async () => {
		const s = new Store(":memory:");
		const { conn } = seed(s);
		const engine = new RenderEngine(
			s,
			new TokenCache({
				clientId: "c",
				clientSecret: "s",
				scope: "sc",
				grantType: "client_credentials",
			}),
			tmp(),
			makeFakeBc({ fixture: "error:consent", latencyMs: 0 }),
		);
		const r = await engine.render(s.layoutDetails()[0]!);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.kind).toBe("consent");
		expect(s.connection(conn.id)?.lastStatus).toBe("not_registered");
		expect(s.lastRender(s.layouts()[0]!.id)?.ok).toBe(false);
		s.close();
	});

	test("renders for one connection serialise; the queue is visible", async () => {
		const s = new Store(":memory:");
		seed(s);
		const engine = engineFor(s, tmp());
		const [detail] = s.layoutDetails();
		const seen: number[] = [];
		engine.on((e) => {
			if (e.type === "queued") seen.push(e.depth);
		});
		await Promise.all([
			engine.render(detail!, { force: true }),
			engine.render(detail!, { force: true }),
			engine.render(detail!, { force: true }),
		]);
		expect(Math.max(...seen)).toBeGreaterThan(1);
		expect(engine.queueDepth(detail!.connection!.id)).toBe(0);
		s.close();
	});
});

describe("native file chooser", () => {
	/**
	 * The dialog itself cannot be opened in CI, so what is asserted is the command for
	 * every platform — from any platform — plus the one property that makes it safe:
	 * nothing the user controls is interpolated into the AppleScript or the PowerShell.
	 */
	test("each desktop gets its own chooser, and none is a hard requirement", async () => {
		const { pickerCommand } = await import("@layout/core");
		const all = () => "/usr/bin/found";
		const none = () => null;

		const mac = pickerCommand({ platform: "darwin", which: all })!;
		expect(mac.argv[0]).toBe("osascript");
		expect(mac.argv.join(" ")).toContain("choose file");

		const win = pickerCommand({ platform: "win32", which: all })!;
		// Windows PowerShell needs -STA for a Forms dialog.
		expect(win.argv.slice(0, 3)).toEqual(["powershell", "-NoProfile", "-STA"]);
		expect(win.argv.join(" ")).toContain("OpenFileDialog");
		const pwshOnly = pickerCommand({
			platform: "win32",
			which: (b) => (b === "pwsh" ? "/usr/bin/pwsh" : null),
		})!;
		expect(pwshOnly.argv[0]).toBe("pwsh");
		expect(pwshOnly.argv).not.toContain("-STA");

		const linux = pickerCommand({ platform: "linux", which: all })!;
		expect(linux.argv[0]).toBe("zenity");
		expect(linux.argv).toContain("--file-selection");
		expect(linux.argv.join(" ")).toContain("*.rdl");

		const kde = pickerCommand({
			platform: "linux",
			which: (b) => (b === "kdialog" ? "/usr/bin/kdialog" : null),
		})!;
		expect(kde.argv[0]).toBe("kdialog");
		expect(kde.argv).toContain("--getopenfilename");

		// The zenity/kdialog branch is every other desktop unix, not Linux alone.
		expect(pickerCommand({ platform: "freebsd", which: all })!.argv[0]).toBe(
			"zenity",
		);

		// No chooser is not a failure of this app: the path stays typeable.
		expect(pickerCommand({ platform: "linux", which: none })).toBeNull();
		expect(pickerCommand({ platform: "win32", which: none })).toBeNull();
		expect(pickerCommand({ platform: "darwin", which: none })).toBeNull();
	});

	test("a hostile directory name is data, not code", async () => {
		const { pickerCommand } = await import("@layout/core");
		const startDir = `/tmp/a"; do shell script "rm -rf ~`;
		const all = () => "/usr/bin/found";

		for (const platform of ["darwin", "win32"]) {
			const cmd = pickerCommand({ platform, which: all, startDir })!;
			// The scripts are constants that read the environment; the directory never
			// reaches the argv, where it would be two languages at once.
			expect(cmd.argv.join(" ")).not.toContain(startDir);
			expect(cmd.env.RDLA_PICK_START).toBe(startDir);
		}

		// The zenity family takes it as a plain argument, which is safe as argv.
		const zenity = pickerCommand({ platform: "linux", which: all, startDir })!;
		expect(zenity.argv.some((a) => a.includes(startDir))).toBe(true);
	});

	/**
	 * This is the case the first version got wrong, caught by looking at the screen: the
	 * dialog was dismissed, GTK had grumbled about a settings.ini key, and the app put
	 * that warning in front of the user as the reason the pick failed.
	 */
	test("toolkit noise on a dismissed dialog is not an error", async () => {
		const { classifyPickOutput } = await import("@layout/core");
		const gtkNoise =
			"zenity: (zenity:146658): Gtk-WARNING **: 16:04:23.573: Unknown key gtk-modules in " +
			"/home/you/.config/gtk-4.0/settings.ini\n";

		expect(
			classifyPickOutput("zenity", {
				stdout: "",
				stderr: gtkNoise,
				exitCode: 1,
			}),
		).toEqual({ kind: "cancelled" });
		expect(
			classifyPickOutput("zenity", { stdout: "", stderr: "", exitCode: 1 }),
		).toEqual({ kind: "cancelled" });
		// A clean exit with no selection is how the Windows dialog reports Cancel.
		expect(
			classifyPickOutput("powershell", { stdout: "", stderr: "", exitCode: 0 }),
		).toEqual({ kind: "cancelled" });
		expect(
			classifyPickOutput("osascript", {
				stdout: "",
				stderr: "User canceled. (-128)",
				exitCode: 1,
			}),
		).toEqual({
			kind: "cancelled",
		});

		// A chooser that could not run still has to say so.
		const broken = classifyPickOutput("zenity", {
			stdout: "",
			stderr: `${gtkNoise}cannot open display: :0`,
			exitCode: 1,
		});
		expect(broken).toEqual({
			kind: "failed",
			message: "zenity: cannot open display: :0",
		});

		// A path always wins, warnings or not.
		expect(
			classifyPickOutput("zenity", {
				stdout: "/tmp/a.rdl\n",
				stderr: gtkNoise,
				exitCode: 0,
			}),
		).toEqual({
			kind: "picked",
			path: "/tmp/a.rdl",
		});
	});

	test("the fake picker answers without spawning anything", async () => {
		const { pickFile } = await import("@layout/core");
		const previous = process.env.RDLA_FAKE_PICKER;
		try {
			process.env.RDLA_FAKE_PICKER = "cancel";
			expect(await pickFile()).toEqual({ ok: false, cancelled: true });

			process.env.RDLA_FAKE_PICKER = "none";
			const unavailable = (await pickFile()) as { ok: false; message: string };
			expect(unavailable.ok).toBe(false);
			// The advice is platform-specific; that it ends at the typed path is not.
			expect(unavailable.message.toLowerCase()).toContain("type the path");

			// A chooser that hands back a path that is gone must say so, not return it.
			process.env.RDLA_FAKE_PICKER = "/no/such/layout.rdl";
			const missing = (await pickFile()) as { ok: false; message: string };
			expect(missing.ok).toBe(false);
			expect(missing.message).toContain("does not exist");

			process.env.RDLA_FAKE_PICKER = import.meta.path;
			expect(await pickFile()).toEqual({ ok: true, path: import.meta.path });
		} finally {
			if (previous === undefined) delete process.env.RDLA_FAKE_PICKER;
			else process.env.RDLA_FAKE_PICKER = previous;
		}
	});
});

describe("report parameters read", () => {
	/**
	 * Same rule as the preview action: OData binds an unbound action's body by parameter
	 * name, so these keys have to match `ListReportSettings` and `GetReportParameters` in
	 * codeunit 60796 exactly. A rename on either side fails at runtime with an unhelpful
	 * message, so it is asserted here instead.
	 */
	test("the bodies name the AL parameters, and an omitted settings name is sent as empty", async () => {
		const {
			settingsRequestBody,
			paramsRequestBody,
			PARAMS_ACTION,
			SETTINGS_ACTION,
		} = await import("@layout/core");
		const connection = {
			id: "c",
			tenantId: "t",
			environment: "e",
			company: "co",
		} as never;

		expect(SETTINGS_ACTION).toBe("PINLayoutPreview_ListReportSettings");
		expect(PARAMS_ACTION).toBe("PINLayoutPreview_GetReportParameters");
		expect(settingsRequestBody({ connection, reportId: 61206 })).toEqual({
			reportId: 61206,
		});

		// The AL parameter is not optional; empty is what means "pick the best match".
		expect(paramsRequestBody({ connection, reportId: 61206 })).toEqual({
			reportId: 61206,
			settingsName: "",
		});
		expect(
			paramsRequestBody({
				connection,
				reportId: 61206,
				settingsName: "Monthly",
			}),
		).toEqual({
			reportId: 61206,
			settingsName: "Monthly",
		});
	});

	test("settings parse defensively — a shape change is not a crash", async () => {
		const { parseReportSettings } = await import("@layout/core");
		expect(
			parseReportSettings(
				'[{"name":"Monthly","user":"ANNA","company":"CRONUS","shared":true,"temporary":false}]',
			),
		).toEqual([
			{
				name: "Monthly",
				user: "ANNA",
				company: "CRONUS",
				shared: true,
				temporary: false,
			},
		]);

		// A row missing fields still lands; anything that is not a JSON array is null, which
		// the caller turns into a BcError rather than an empty list that looks like "none".
		expect(parseReportSettings('[{"name":"Bare"}]')).toEqual([
			{ name: "Bare", user: "", company: "", shared: false, temporary: false },
		]);
		expect(parseReportSettings("[]")).toEqual([]);
		expect(parseReportSettings("not json")).toBeNull();
		expect(parseReportSettings('{"name":"object"}')).toBeNull();
	});

	test("a refused read reads as BC's own sentence, not as a failed render", async () => {
		const { describeBcError, describeBcFailure } = await import("@layout/core");
		const error = {
			kind: "render",
			bcMessage: "Report 61206 has no saved settings you can read.",
		} as const;
		expect(describeBcError(error)).toContain("could not render the layout");
		expect(describeBcFailure(error)).toBe(
			"Report 61206 has no saved settings you can read.",
		);
		// Everything else keeps the taxonomy's own wording.
		expect(
			describeBcFailure({
				kind: "throttle",
				retryAfterMs: 1000,
				detail: "HTTP 429",
			}),
		).toContain("throttled");
	});
});

describe("legacy BC action", () => {
	/**
	 * Both halves have to switch together: the action name and the body key. Asserting
	 * them separately would let one drift and still pass.
	 */
	test("modern shape names the format and the layout payload", async () => {
		const { previewAction, previewRequestBody, usingLegacyAction } =
			await import("@layout/core");
		delete process.env.LAYOUT_BC_LEGACY;
		expect(usingLegacyAction()).toBe(false);
		expect(previewAction()).toBe("PINLayoutPreview_PreviewLayout");
		const body = previewRequestBody({
			connection: {
				id: "c",
				tenantId: "t",
				environment: "e",
				company: "co",
			} as never,
			reportId: 61206,
			reportParamsXml: "<x/>",
			layoutBase64: "AAA=",
			layoutFormat: "RDLC",
		});
		expect(Object.keys(body).sort()).toEqual([
			"description",
			"layoutFileAsBase64",
			"layoutFormat",
			"reportId",
			"reportParamsXml",
		]);
	});

	test("LAYOUT_BC_LEGACY=1 switches the action and the body together", async () => {
		const { previewAction, previewRequestBody, usingLegacyAction } =
			await import("@layout/core");
		process.env.LAYOUT_BC_LEGACY = "1";
		try {
			expect(usingLegacyAction()).toBe(true);
			expect(previewAction()).toBe("RdlpApi_PreviewRdl");
			const body = previewRequestBody({
				connection: {
					id: "c",
					tenantId: "t",
					environment: "e",
					company: "co",
				} as never,
				reportId: 61206,
				reportParamsXml: "<x/>",
				layoutBase64: "AAA=",
				layoutFormat: "RDLC",
			});
			// The old action has no layoutFormat and names the payload rdlFileAsBase64.
			expect(Object.keys(body).sort()).toEqual([
				"description",
				"rdlFileAsBase64",
				"reportId",
				"reportParamsXml",
			]);
		} finally {
			delete process.env.LAYOUT_BC_LEGACY;
		}
	});
});
