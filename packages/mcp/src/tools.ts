/**
 * The `layout_*` tool surface.
 *
 * Bound to one layout for the life of a session, because the agent's `cwd` is that
 * layout's directory and it has no business rendering someone else's client.
 *
 * Deliberately absent: any file read/write tool. Every provider already has Read and
 * Edit, and the layout is XML they can edit directly — adding our own would duplicate
 * the surface and put us in the business of arbitrating writes we cannot see.
 */
import {
	describeBcError,
	type RenderEngine,
	type RenderResult,
	type Store,
} from "@layout/core";
import {
	diffGeometry,
	formatFindings,
	formatLocateResult,
	layoutText,
	lintLayoutXml,
	locate,
	pageImage,
} from "@layout/feedback";
import { failure, type Tool, type ToolResult, text } from "./server.ts";

export type LoopLimits = {
	maxIterations: number;
	maxImagesPerIteration: number;
};

export type ToolContext = {
	store: Store;
	engine: RenderEngine;
	layoutId: string;
	workDir: string;
	limits?: Partial<LoopLimits>;
	/** Called with every tool call for session instrumentation and UI streaming. */
	onCall?: (call: {
		tool: string;
		args: Record<string, unknown>;
		ms: number;
		isError: boolean;
		estimatedTokens: number;
	}) => void;
	/** Suppress the file watcher while the agent works, so it does not double-render. */
	suppressWatch?: (layoutId: string) => () => void;
};

const DEFAULT_LIMITS: LoopLimits = {
	maxIterations: 10,
	maxImagesPerIteration: 3,
};

/** Text is ~4 chars per token; images are width × height / 750, which the caller supplies. */
function estimateTokens(r: ToolResult, imageTokens: number): number {
	let n = 0;
	for (const c of r.content)
		n += c.type === "text" ? Math.ceil(c.text.length / 4) : imageTokens;
	return n;
}

export function createLayoutTools(ctx: ToolContext): Tool[] {
	const limits: LoopLimits = { ...DEFAULT_LIMITS, ...ctx.limits };
	let iteration = 0;
	let imagesThisIteration = 0;
	let pendingImageTokens = 0;

	const layout = () => {
		const d = ctx.store.layoutDetails({ layoutId: ctx.layoutId })[0];
		if (!d) throw new Error(`Layout ${ctx.layoutId} no longer exists.`);
		return d;
	};

	const instrument = (
		name: string,
		fn: (a: Record<string, unknown>) => Promise<ToolResult>,
	): Tool["handler"] => {
		return async (args) => {
			const started = performance.now();
			pendingImageTokens = 0;
			const result = await fn(args);
			ctx.onCall?.({
				tool: name,
				args,
				ms: Math.round(performance.now() - started),
				isError: result.isError ?? false,
				estimatedTokens: estimateTokens(result, pendingImageTokens),
			});
			return result;
		};
	};

	const currentPdf = () => ctx.engine.state(ctx.layoutId).currentPdf;

	const renderTool: Tool = {
		name: "layout_render",
		title: "Render the layout in Business Central",
		description:
			"Send the current layout file to Business Central and render it to PDF, then return " +
			"the deterministic lint findings, the layout text, and a geometry diff against the " +
			"previous render. This is a live network round trip to a real BC tenant, so it is the " +
			"slowest and most expensive tool here — make all your edits, then render once.\n\n" +
			"You must state, in `expectation`, what you expect this render to change before you " +
			"call it. If the geometry diff does not match your expectation, your edit did " +
			"something other than what you intended; investigate before editing again.",
		inputSchema: {
			type: "object",
			properties: {
				expectation: {
					type: "string",
					description:
						'What you expect to change in this render, and why — e.g. "the User ID column ' +
						'widens by ~0.6cm so SRICHARAN stops splitting across two lines; nothing else moves".',
				},
				force: {
					type: "boolean",
					description:
						"Render even if the layout bytes are unchanged since the last render. Normally " +
						"leave this off: an unchanged file returns the cached result for free.",
				},
			},
			required: ["expectation"],
		},
		handler: instrument("layout_render", async (args) => {
			// Only an explicit call here spends the iteration budget. The file watcher also
			// renders on every edit now (hot reload), but those are deliberately uncounted —
			// and an unchanged file makes this call return the watcher's cached render for
			// free (see the content-hash short-circuit in RenderEngine).
			//
			// Validate before touching any budget. A malformed call is a mistake, not an
			// iteration — and if a rejected call reset the image budget, an agent could bypass
			// the images-per-iteration cap just by making one.
			const expectation = String(args.expectation ?? "").trim();
			if (expectation.length < 10) {
				return failure(
					"State a concrete expectation before rendering: what should change, and what should " +
						"stay put. This is how you tell a successful edit from a lucky one.",
				);
			}
			if (iteration + 1 > limits.maxIterations) {
				return failure(
					`Iteration cap of ${limits.maxIterations} renders reached. Stop and report what you ` +
						`have changed, what worked, and what is still wrong. Do not keep iterating.`,
				);
			}
			iteration += 1;
			imagesThisIteration = 0;

			const before = await ctx.engine.geometryOf(ctx.layoutId, "current");
			const release = ctx.suppressWatch?.(ctx.layoutId);
			let result: RenderResult;
			try {
				result = await ctx.engine.render(layout(), {
					force: Boolean(args.force),
				});
			} finally {
				release?.();
			}

			if (!result.ok) {
				return failure(
					[
						`Render FAILED after ${result.durationMs}ms (iteration ${iteration}/${limits.maxIterations}).`,
						describeBcError(result.error),
						result.lint.length
							? `\nPre-render lint:\n${formatFindings(result.lint)}`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
				);
			}

			const after = await ctx.engine.geometryOf(ctx.layoutId, "current");
			const parts = [
				`Render OK — ${result.pageCount} page(s), ${result.durationMs}ms` +
					`${result.cached ? " (cached: layout bytes unchanged, no BC round trip)" : ""}. ` +
					`Iteration ${iteration}/${limits.maxIterations}.`,
				`\nYou expected: ${expectation}`,
				`\n## Lint\n${formatFindings(result.lint)}`,
			];
			parts.push(
				before && after
					? `\n## Geometry change since the previous render\n${diffGeometry(before, after)}`
					: "\n## Geometry change\nFirst render of this session — nothing to compare against yet.",
			);
			parts.push(`\n## Layout text\n${await layoutText(result.pdfPath)}`);
			return text(parts.join("\n"));
		}),
	};

	const lintTool: Tool = {
		name: "layout_lint",
		title: "Check the layout XML without rendering",
		description:
			"Run the deterministic rules against the layout file as it stands on disk. Free and " +
			"instant — no Business Central round trip. Catches body-wider-than-page (the fault " +
			"that makes every second page blank), items overhanging the body, and overlaps. " +
			"Call this after editing and before rendering.",
		inputSchema: { type: "object", properties: {} },
		handler: instrument("layout_lint", async () => {
			const l = layout();
			if (l.kind !== "rdl")
				return text("Lint runs on RDL only; this is a Word layout.");
			const xml = await Bun.file(l.filePath).text();
			return text(formatFindings(lintLayoutXml(xml, l.filePath)));
		}),
	};

	const textTool: Tool = {
		name: "layout_text",
		title: "Read the rendered page as laid-out text",
		description:
			"The last render as `pdftotext -layout` output: values, column boundaries, wrapping, " +
			"truncation, ordering. Cheap. Column truncation and wrapped cells are all visible " +
			"here — reach for a page image only when the question is genuinely visual " +
			"(alignment, borders, shading, font weight, spacing).",
		inputSchema: {
			type: "object",
			properties: {
				page: {
					type: "number",
					description: "1-based page number. Omit for all pages.",
				},
			},
		},
		handler: instrument("layout_text", async (args) => {
			const pdf = currentPdf();
			if (!pdf)
				return failure("Nothing rendered yet. Call layout_render first.");
			return text(
				await layoutText(
					pdf,
					args.page === undefined ? undefined : Number(args.page),
				),
			);
		}),
	};

	const diffTool: Tool = {
		name: "layout_diff",
		title: "Geometry delta against the previous render",
		description:
			"What actually moved between the last two renders, in points: word groups that " +
			"shifted, rendered widths that changed, lines that started or stopped wrapping, and " +
			"text that appeared or disappeared. Use this to confirm an edit did exactly what you " +
			"intended and nothing else.",
		inputSchema: { type: "object", properties: {} },
		handler: instrument("layout_diff", async () => {
			const before = await ctx.engine.geometryOf(ctx.layoutId, "previous");
			const after = await ctx.engine.geometryOf(ctx.layoutId, "current");
			if (!after)
				return failure("Nothing rendered yet. Call layout_render first.");
			if (!before)
				return text("Only one render so far — nothing to diff against.");
			return text(diffGeometry(before, after));
		}),
	};

	const locateTool: Tool = {
		name: "layout_locate",
		title: "Find the layout element that produced something on the page",
		description:
			"Given rendered text or a page coordinate, return the layout element responsible, " +
			"with its file:line, current Width and CanGrow, and — inside a table — the column it " +
			"belongs to and that column's declared width.\n\n" +
			"Use this instead of searching the XML. The file is thousands of lines with over a " +
			"hundred textboxes, most named nothing like the text they render, and data cells " +
			"contain field expressions rather than the values you can see. This tool does the " +
			"join for you.",
		inputSchema: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description:
						'Rendered text, e.g. "SRICHARAN" or "Credit Memo". A phrase that wrapped is fine.',
				},
				x: {
					type: "number",
					description: "Page x in points (from layout_page_image's mapping).",
				},
				y: { type: "number", description: "Page y in points." },
				page: {
					type: "number",
					description: "1-based page number. Default 1.",
				},
			},
		},
		handler: instrument("layout_locate", async (args) => {
			const l = layout();
			if (l.kind !== "rdl")
				return failure("layout_locate currently supports RDL layouts only.");
			const geo = await ctx.engine.geometryOf(ctx.layoutId, "current");
			if (!geo)
				return failure("Nothing rendered yet. Call layout_render first.");

			const hasCoords = args.x !== undefined && args.y !== undefined;
			const queryText = args.text === undefined ? undefined : String(args.text);
			if (!hasCoords && queryText === undefined) {
				return failure("Give either `text` or both `x` and `y`.");
			}
			const xml = await Bun.file(l.filePath).text();
			const result = locate(xml, l.filePath, geo, {
				page: args.page === undefined ? 1 : Number(args.page),
				text: queryText,
				coords: hasCoords
					? { x: Number(args.x), y: Number(args.y) }
					: undefined,
			});
			return text(formatLocateResult(result));
		}),
	};

	const imageTool: Tool = {
		name: "layout_page_image",
		title: "See a rendered page",
		description:
			"A PNG of one rendered page, trimmed to its content by default. Use for visual " +
			"judgement only: alignment, borders, shading, font weight and size, spacing, " +
			'"does this look right". Prefer `region` to zoom into a suspect area over ' +
			"re-sending a whole page — it is both cheaper and more legible.\n\n" +
			"Set `trim: false` when judging margins: trimming crops away the whitespace that " +
			"makes a margin overflow visible.",
		inputSchema: {
			type: "object",
			properties: {
				page: {
					type: "number",
					description: "1-based page number. Default 1.",
				},
				dpi: {
					type: "number",
					description: "Default 150. Raise to 200+ only with a region.",
				},
				region: {
					type: "array",
					items: { type: "number" },
					description:
						"[x, y, width, height] in PDF points, origin top-left. Omit for the whole page.",
				},
				trim: {
					type: "boolean",
					description:
						"Trim to content. Default true. Set false to judge margins.",
				},
			},
		},
		handler: instrument("layout_page_image", async (args) => {
			const pdf = currentPdf();
			if (!pdf)
				return failure("Nothing rendered yet. Call layout_render first.");
			if (imagesThisIteration >= limits.maxImagesPerIteration) {
				return failure(
					`Already returned ${limits.maxImagesPerIteration} images since the last render, which ` +
						`is the cap. Use layout_text, layout_diff or layout_locate to answer this, or make ` +
						`an edit and render again.`,
				);
			}
			imagesThisIteration += 1;

			const region = Array.isArray(args.region)
				? (args.region as unknown[]).map(Number).slice(0, 4)
				: undefined;
			const img = await pageImage(
				pdf,
				`${ctx.workDir}/raster/${ctx.layoutId}`,
				{
					page: args.page === undefined ? 1 : Number(args.page),
					dpi: args.dpi === undefined ? 150 : Number(args.dpi),
					trim: args.trim === undefined ? true : Boolean(args.trim),
					region:
						region?.length === 4
							? (region as [number, number, number, number])
							: undefined,
				},
			);
			pendingImageTokens = img.estimatedTokens;

			const data = Buffer.from(await Bun.file(img.path).arrayBuffer()).toString(
				"base64",
			);
			return {
				content: [
					{
						type: "text",
						text:
							`Page ${args.page ?? 1} at ${img.dpi} dpi, ${img.widthPx}×${img.heightPx}px` +
							`${img.trimmed ? " (trimmed to content)" : ""}.\n` +
							`To convert a pixel (px, py) in this image to a PDF point coordinate: ` +
							`x = (px + ${img.offsetXPx}) × ${img.pointsPerPixel.toFixed(4)}, ` +
							`y = (py + ${img.offsetYPx}) × ${img.pointsPerPixel.toFixed(4)}. ` +
							`Pass those to layout_locate to find the element that drew it.`,
					},
					{ type: "image", data, mimeType: "image/png" },
				],
			};
		}),
	};

	const paramsTool: Tool = {
		name: "layout_params",
		title: "Inspect the render context",
		description:
			"The report, the client, the connection this renders against, the layout file path, " +
			"and the preview parameters. Read-only; useful for orienting yourself before editing.",
		inputSchema: { type: "object", properties: {} },
		handler: instrument("layout_params", async () => {
			const l = layout();
			return text(
				[
					`Report:      ${l.reportNumber} ${l.reportName}`,
					`Client:      ${l.clientName}`,
					`Layout file: ${l.filePath}  (${l.kind})`,
					`Connection:  ${l.connection ? `${l.connection.environment} / ${l.connection.company}` : "none assigned"}`,
					`Iteration:   ${iteration}/${limits.maxIterations}`,
					``,
					`Preview parameters (reportParamsXml):`,
					l.paramsXml ?? "(none set)",
				].join("\n"),
			);
		}),
	};

	return [
		renderTool,
		lintTool,
		textTool,
		diffTool,
		locateTool,
		imageTool,
		paramsTool,
	];
}
