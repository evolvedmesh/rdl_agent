import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeBc, RenderEngine, Store, TokenCache } from "@layout/core";
import {
	createLayoutTools,
	McpServer,
	mcpHttpHandler,
	type Tool,
} from "@layout/mcp";

const FIXTURE_PDF = join(import.meta.dir, "fixtures", "preview.pdf");
const FIXTURE_RDL = join(import.meta.dir, "fixtures", "Default.rdl");
const tmp = () => mkdtempSync(join(tmpdir(), "layout-mcp-"));

async function harness(
	opts: {
		fixture?: string;
		layout?: string;
		limits?: { maxIterations?: number; maxImagesPerIteration?: number };
	} = {},
) {
	const workDir = tmp();
	const layoutPath = opts.layout ?? join(workDir, "Default.rdl");
	if (!opts.layout) await Bun.write(layoutPath, Bun.file(FIXTURE_RDL));

	const store = new Store(":memory:");
	const client = store.createClient("Hawks");
	const conn = store.createConnection({
		clientId: client.id,
		label: "Dev3",
		tenantId: "t",
		environment: "Dev3",
		company: "HAWKS",
		isDefault: true,
	});
	const report = store.upsertReport(61206, "VAT Settlement");
	const layout = store.createLayout({
		reportId: report.id,
		clientId: client.id,
		connectionId: conn.id,
		kind: "rdl",
		filePath: layoutPath,
		paramsXml: "<ReportParameters/>",
	});

	const engine = new RenderEngine(
		store,
		new TokenCache({
			clientId: "c",
			clientSecret: "s",
			scope: "sc",
			grantType: "client_credentials",
		}),
		workDir,
		makeFakeBc({ fixture: opts.fixture ?? FIXTURE_PDF, latencyMs: 0 }),
	);

	const calls: { tool: string; estimatedTokens: number }[] = [];
	const tools = createLayoutTools({
		store,
		engine,
		layoutId: layout.id,
		workDir,
		limits: opts.limits,
		onCall: (c) =>
			calls.push({ tool: c.tool, estimatedTokens: c.estimatedTokens }),
	});
	const byName = new Map(tools.map((t) => [t.name, t]));
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = byName.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		const r = await tool.handler(args);
		return {
			text: r.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n"),
			images: r.content.filter((c) => c.type === "image").length,
			isError: r.isError ?? false,
		};
	};
	return {
		store,
		engine,
		tools,
		call,
		calls,
		layoutPath,
		layoutId: layout.id,
		workDir,
	};
}

describe("tool surface", () => {
	test("exposes exactly the seven layout_* tools and no file access", async () => {
		const { tools } = await harness();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"layout_diff",
			"layout_lint",
			"layout_locate",
			"layout_page_image",
			"layout_params",
			"layout_render",
			"layout_text",
		]);
		// The agent's own Read/Edit already cover the XML; duplicating them here would put
		// us in the business of arbitrating writes we cannot see.
		expect(names.some((n) => /read|write|edit|file/.test(n))).toBe(false);
	});

	test("every tool carries a description worth reading", async () => {
		const { tools } = await harness();
		for (const t of tools) expect(t.description.length).toBeGreaterThan(120);
	});

	test("no rdl_* naming survives — docx would not fit it", async () => {
		const { tools } = await harness();
		expect(tools.every((t) => t.name.startsWith("layout_"))).toBe(true);
	});
});

describe("loop controls", () => {
	test("a render without a concrete expectation is refused", async () => {
		const { call } = await harness();
		expect((await call("layout_render", {})).isError).toBe(true);
		expect((await call("layout_render", { expectation: "fix" })).isError).toBe(
			true,
		);
		expect(
			(await call("layout_render", { expectation: "baseline" })).isError,
		).toBe(true);
	});

	test("rejected renders consume no iteration and no image budget", async () => {
		const { call } = await harness({
			limits: { maxIterations: 2, maxImagesPerIteration: 1 },
		});
		await call("layout_render", { expectation: "no" });
		const first = await call("layout_render", {
			expectation: "baseline render, nothing should change",
		});
		expect(first.text).toContain("Iteration 1/2");

		await call("layout_page_image", {});
		await call("layout_render", { expectation: "x" }); // rejected
		// If a rejected render reset the budget, an agent could bypass the image cap.
		expect((await call("layout_page_image", {})).isError).toBe(true);
	});

	test("the iteration cap stops the loop", async () => {
		const { call } = await harness({ limits: { maxIterations: 2 } });
		await call("layout_render", { expectation: "first render of the session" });
		await call("layout_render", {
			expectation: "second render of the session",
		});
		const third = await call("layout_render", {
			expectation: "third render of the session",
		});
		expect(third.isError).toBe(true);
		expect(third.text).toContain("Iteration cap");
	});
});

describe("convergence signals", () => {
	test("a cached render says the file never changed, rather than implying a new result", async () => {
		const { call } = await harness();
		await call("layout_render", {
			expectation: "baseline render, nothing yet",
		});
		const again = await call("layout_render", {
			expectation: "widen the User ID column so SRICHARAN fits on one line",
		});

		// The trap this closes: an agent edits the wrong file, renders, sees "Render OK"
		// and concludes its edit worked. It has to be told the bytes are identical.
		expect(again.text).toContain("has not changed");
		expect(again.text.toLowerCase()).toContain("did not reach the file");
	});

	test("an edit that changes bytes but moves nothing is called out", async () => {
		const { call, layoutPath } = await harness();
		await call("layout_render", {
			expectation: "baseline render, nothing yet",
		});

		// A comment is a real byte change the renderer cannot possibly act on — the
		// mechanical shape of "you edited something that does not draw anything".
		const xml = await Bun.file(layoutPath).text();
		await Bun.write(layoutPath, `${xml}\n<!-- a change that draws nothing -->`);

		const r = await call("layout_render", {
			expectation:
				"the User ID column should widen and SRICHARAN stop wrapping",
		});
		expect(r.text).toContain("Nothing moved");
		// And it should point at the cheap tool that answers "what actually draws this?"
		expect(r.text).toContain("layout_locate");
	});

	test("every render states the remaining budget, so the cap is never a surprise", async () => {
		const { call } = await harness({ limits: { maxIterations: 3 } });
		const first = await call("layout_render", {
			expectation: "baseline render of the untouched layout",
		});
		expect(first.text).toContain("2 render(s)");

		const second = await call("layout_render", {
			expectation: "second render, budget should have gone down by one",
		});
		expect(second.text).toContain("1 render(s)");
	});

	test("a failed render reports the budget too — a wasted round trip still counts", async () => {
		const { call } = await harness({ fixture: "error:render" });
		const r = await call("layout_render", {
			expectation: "this one is going to fail against the fake tenant",
		});
		expect(r.isError).toBe(true);
		expect(r.text).toContain("Budget:");
	});
});

describe("the ladder", () => {
	test("render returns lint, layout text and a diff, in that order", async () => {
		const { call } = await harness();
		const r = await call("layout_render", {
			expectation: "baseline render of the untouched layout",
		});
		expect(r.isError).toBe(false);
		expect(r.text).toContain("## Lint");
		expect(r.text).toContain("## Geometry change");
		expect(r.text).toContain("## Layout text");
		expect(r.text).toContain("You expected:");
	});

	test("unchanged bytes are deduped; changed bytes are not", async () => {
		const { call, layoutPath } = await harness();
		await call("layout_render", {
			expectation: "baseline render of the untouched layout",
		});
		const cached = await call("layout_render", {
			expectation: "unchanged bytes, expect a cache hit",
		});
		expect(cached.text).toContain("cached");

		const xml = await Bun.file(layoutPath).text();
		await Bun.write(
			layoutPath,
			xml.replace(
				/(<\/Body>\s*)<Width>[^<]*<\/Width>/,
				"$1<Width>17.9cm</Width>",
			),
		);
		const changed = await call("layout_render", {
			expectation: "narrowed the body, the table should shift",
		});
		expect(changed.text).not.toContain("cached");
	});

	test("lint runs with no render and no network", async () => {
		const { call, layoutPath } = await harness();
		const xml = await Bun.file(layoutPath).text();
		await Bun.write(
			layoutPath,
			xml.replace(
				/(<\/Body>\s*)<Width>[^<]*<\/Width>/,
				"$1<Width>25cm</Width>",
			),
		);
		const r = await call("layout_lint");
		expect(r.text).toContain("body-exceeds-page-width");
		expect(r.text).toMatch(/Default\.rdl:\d+/);
	});

	test("malformed XML fails before spending a BC round trip", async () => {
		const { call, layoutPath, store, layoutId } = await harness();
		const xml = await Bun.file(layoutPath).text();
		await Bun.write(layoutPath, xml.replace("</Report>", "</Repor>"));
		const r = await call("layout_render", {
			expectation: "this layout is malformed and must not reach BC",
		});
		expect(r.isError).toBe(true);
		expect(r.text).toContain("well-formed");
		expect(store.lastRender(layoutId)?.ok).toBe(false);
	});

	test("locate maps rendered text back to the element that drew it", async () => {
		const { call } = await harness();
		await call("layout_render", {
			expectation: "baseline render so there is geometry to locate against",
		});
		const r = await call("layout_locate", { text: "SRICHAR" });
		expect(r.text).toContain("Tablix column 10");
		expect(r.text).toMatch(/Default\.rdl:\d+/);
	});

	test("page images are capped and carry the pixel→point mapping", async () => {
		const { call } = await harness({ limits: { maxImagesPerIteration: 2 } });
		await call("layout_render", {
			expectation: "baseline render before asking for pixels",
		});
		const a = await call("layout_page_image", {});
		expect(a.images).toBe(1);
		expect(a.text).toContain("layout_locate");
		expect(a.text).toMatch(/x = \(px \+ \d+\)/);
		await call("layout_page_image", { region: [40, 200, 300, 120], dpi: 200 });
		expect((await call("layout_page_image", {})).isError).toBe(true);
	});

	test("tools that need a render say so instead of failing obscurely", async () => {
		const { call } = await harness();
		for (const name of ["layout_text", "layout_diff", "layout_locate"]) {
			const r = await call(name, name === "layout_locate" ? { text: "x" } : {});
			expect(r.isError).toBe(true);
			expect(r.text).toContain("layout_render");
		}
	});

	test("BC's own message reaches the agent as a tool error", async () => {
		const { call } = await harness({ fixture: "error:render" });
		const r = await call("layout_render", {
			expectation: "provoking a render failure",
		});
		expect(r.isError).toBe(true);
		expect(r.text).toContain("could not be rendered");
		expect(r.text).toContain("negative value");
	});

	test("a text-first iteration stays inside the ~600 token budget", async () => {
		const { call, calls } = await harness();
		await call("layout_render", {
			expectation: "baseline render to measure the feedback cost",
		});
		const render = calls.find((c) => c.tool === "layout_render")!;
		expect(render.estimatedTokens).toBeLessThan(900);
	});
});

describe("wire protocol", () => {
	async function rpc(
		server: McpServer,
		method: string,
		params?: Record<string, unknown>,
	) {
		return server.handle({ id: 1, method, params });
	}

	test("initialize, tools/list and tools/call over the dispatch path", async () => {
		const { tools } = await harness();
		const server = new McpServer({ name: "layout", version: "0.1.0" }).tools(
			tools as Tool[],
		);

		const init = (await rpc(server, "initialize", {
			protocolVersion: "2025-06-18",
		})) as { protocolVersion: string };
		expect(init.protocolVersion).toBe("2025-06-18");

		const list = (await rpc(server, "tools/list")) as {
			tools: { name: string }[];
		};
		expect(list.tools).toHaveLength(7);

		const called = (await rpc(server, "tools/call", {
			name: "layout_params",
			arguments: {},
		})) as {
			content: { type: string; text: string }[];
		};
		expect(called.content[0]!.text).toContain("61206");
	});

	test("an unsupported protocol version falls back rather than failing", async () => {
		const server = new McpServer({ name: "layout", version: "0.1.0" });
		const init = (await rpc(server, "initialize", {
			protocolVersion: "1999-01-01",
		})) as { protocolVersion: string };
		expect(init.protocolVersion).toBe("2025-06-18");
	});

	test("an unknown tool is a tool error, not a protocol crash", async () => {
		const { tools } = await harness();
		const server = new McpServer({ name: "layout", version: "0.1.0" }).tools(
			tools as Tool[],
		);
		expect(
			rpc(server, "tools/call", { name: "nope", arguments: {} }),
		).rejects.toThrow(/Unknown tool/);
	});
});

/**
 * `mcpHttpHandler` takes a function, not a `Map`, and this is the whole reason: the
 * server built the handler once, at startup, before any session existed, and passing
 * the `Map` directly closed over that empty snapshot forever. Every session created
 * afterward — every real one, for the entire life of the app — came back "unknown
 * session" no matter what, which silently took every `layout_*` tool away from every
 * agent. This reproduces the exact shape of that bug: build the handler first, add a
 * session second, and prove the SAME handler instance can still find it.
 */
describe("mcpHttpHandler (session map is looked up live, not snapshotted)", () => {
	test("a session added after the handler is built is still reachable", async () => {
		const live = new Map<string, McpServer>();
		const handler = mcpHttpHandler(() => live); // built while `live` is empty

		const req = (method: string) =>
			new Request("http://x/mcp/s1", {
				method: "POST",
				body: JSON.stringify({ id: 1, method, params: {} }),
			});

		const before = await handler(req("initialize"), "s1");
		expect(before.status).toBe(404);
		expect(await before.json()).toEqual({ error: "unknown session" });

		// The session is created after the handler already exists — exactly the real
		// sequence: createApp() builds mcpHttp, then every session comes later.
		live.set("s1", new McpServer({ name: "layout", version: "0.1.0" }));

		const after = await handler(req("initialize"), "s1");
		expect(after.status).toBe(200);
		const body = (await after.json()) as {
			result?: { protocolVersion?: string };
		};
		expect(body.result?.protocolVersion).toBe("2025-06-18");
	});

	test("a session that is genuinely unknown is still a plain 404", async () => {
		const handler = mcpHttpHandler(() => new Map());
		const res = await handler(
			new Request("http://x/mcp/ghost", {
				method: "POST",
				body: JSON.stringify({ id: 1, method: "initialize" }),
			}),
			"ghost",
		);
		expect(res.status).toBe(404);
	});
});
