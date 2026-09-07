/**
 * RenderEngine: the contract everything downstream depends on.
 *
 *  - content-hash dedupe *before* queueing. A watcher event, an agent tool call and a UI
 *    refresh can all ask for the same render within a second; identical bytes must never
 *    cost a BC round trip twice.
 *  - serialize per connection, parallelize across connections. BC throttles per
 *    environment, so one client's bulk re-render must not starve another's interactive
 *    loop — and the queue depth is surfaced so the UI can say "3 of 7, Acme behind
 *    Hawks" rather than looking frozen.
 *  - every failure captured as structured data on a render row, not a console.error.
 *  - keep the previous render so the geometry diff has something to compare against.
 */
import { mkdir } from "node:fs/promises";
import {
	child,
	childText,
	findAll,
	type Geometry,
	geometry,
	type LintFinding,
	lintLayoutXml,
	lintRender,
	pageCount,
	parseXml,
	toPoints,
} from "@layout/feedback";
import {
	type BcError,
	layoutFormatFor,
	type PreviewRequest,
	type PreviewResult,
	previewLayout,
	type TokenCache,
} from "./bc.ts";
import type { Connection, LayoutDetail, Store } from "./store.ts";

export type RenderResult =
	| {
			ok: true;
			layoutId: string;
			pdfPath: string;
			pageCount: number;
			contentHash: string;
			durationMs: number;
			lint: LintFinding[];
			/** True when the bytes were unchanged and no BC round trip was made. */
			cached: boolean;
	  }
	| {
			ok: false;
			layoutId: string;
			error: BcError;
			durationMs: number;
			lint: LintFinding[];
	  };

export type PageMargins = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

/** Pull the printable area out of the layout so post-render lint can check overhang. */
export function pageMarginsFromXml(xml: string): PageMargins | undefined {
	try {
		const section = findAll(parseXml(xml), "ReportSection")[0];
		const page = section ? child(section, "Page") : undefined;
		if (!page) return undefined;
		return {
			left: toPoints(childText(page, "LeftMargin")) ?? 0,
			right: toPoints(childText(page, "RightMargin")) ?? 0,
			top: toPoints(childText(page, "TopMargin")) ?? 0,
			bottom: toPoints(childText(page, "BottomMargin")) ?? 0,
		};
	} catch {
		return undefined;
	}
}

type LayoutState = {
	currentHash?: string;
	currentPdf?: string;
	currentPageCount?: number;
	previousPdf?: string;
	/** Cached because parsing costs ~100ms and the diff needs both sides. */
	currentGeometry?: Geometry;
	previousGeometry?: Geometry;
};

/** Injectable so a recorded fixture can stand in for a live tenant. */
export type RenderTransport = (
	tokens: TokenCache,
	req: PreviewRequest,
) => Promise<PreviewResult>;

export type QueueSnapshot = {
	connectionId: string;
	depth: number;
	running: boolean;
};

export type RenderEvent =
	| { type: "queued"; layoutId: string; connectionId: string; depth: number }
	| { type: "started"; layoutId: string; connectionId: string }
	| {
			type: "finished";
			layoutId: string;
			connectionId: string;
			result: RenderResult;
	  };

export class RenderEngine {
	#state = new Map<string, LayoutState>();
	/** One promise chain per connection id. */
	#queues = new Map<string, Promise<unknown>>();
	#depth = new Map<string, number>();
	#running = new Set<string>();
	#listeners = new Set<(e: RenderEvent) => void>();

	constructor(
		private readonly store: Store,
		private readonly tokens: TokenCache,
		private readonly workDir: string,
		private readonly transport: RenderTransport = previewLayout,
	) {}

	on(listener: (e: RenderEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(e: RenderEvent): void {
		for (const l of this.#listeners) {
			try {
				l(e);
			} catch {
				/* a bad listener must not break a render */
			}
		}
	}

	state(layoutId: string): LayoutState {
		let s = this.#state.get(layoutId);
		if (!s) {
			s = {};
			this.#state.set(layoutId, s);
		}
		return s;
	}

	/** What the UI shows so a queued render does not look like a hung app. */
	queues(): QueueSnapshot[] {
		return [...this.#depth.entries()]
			.filter(([, d]) => d > 0)
			.map(([connectionId, depth]) => ({
				connectionId,
				depth,
				running: this.#running.has(connectionId),
			}));
	}

	queueDepth(connectionId: string): number {
		return this.#depth.get(connectionId) ?? 0;
	}

	async render(
		layout: LayoutDetail,
		opts: { force?: boolean } = {},
	): Promise<RenderResult> {
		const connection = layout.connection;
		if (!connection) {
			const err: RenderResult = {
				ok: false,
				layoutId: layout.id,
				error: {
					kind: "network",
					detail: `Layout "${layout.reportName}" for ${layout.clientName} has no connection assigned. Pick one before rendering.`,
				},
				durationMs: 0,
				lint: [],
			};
			return err;
		}

		const key = connection.id;
		this.#depth.set(key, this.queueDepth(key) + 1);
		this.#emit({
			type: "queued",
			layoutId: layout.id,
			connectionId: key,
			depth: this.queueDepth(key),
		});

		const prior = this.#queues.get(key) ?? Promise.resolve();
		const run = prior
			.catch(() => undefined)
			.then(async () => {
				this.#running.add(key);
				this.#emit({ type: "started", layoutId: layout.id, connectionId: key });
				try {
					return await this.#renderNow(layout, connection, opts);
				} finally {
					this.#running.delete(key);
					this.#depth.set(key, Math.max(0, this.queueDepth(key) - 1));
				}
			})
			.then((result) => {
				this.#emit({
					type: "finished",
					layoutId: layout.id,
					connectionId: key,
					result,
				});
				return result;
			});

		this.#queues.set(key, run);
		return run;
	}

	async #renderNow(
		layout: LayoutDetail,
		connection: Connection,
		opts: { force?: boolean },
	): Promise<RenderResult> {
		const started = performance.now();
		const done = () => Math.round(performance.now() - started);
		const state = this.state(layout.id);

		const file = Bun.file(layout.filePath);
		if (!(await file.exists())) {
			const error: BcError = {
				kind: "network",
				detail: `Layout file not found: ${layout.filePath}`,
			};
			this.store.recordRender({
				layoutId: layout.id,
				contentHash: "",
				pdfPath: null,
				ok: false,
				error: error.detail,
				durationMs: done(),
			});
			return {
				ok: false,
				layoutId: layout.id,
				error,
				durationMs: done(),
				lint: [],
			};
		}

		const bytes = await file.arrayBuffer();
		const isXml = layout.kind === "rdl";
		const xml = isXml ? new TextDecoder().decode(bytes) : "";

		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(new Uint8Array(bytes));
		hasher.update(layout.paramsXml ?? "");
		hasher.update(String(layout.reportNumber));
		const contentHash = hasher.digest("hex").slice(0, 16);

		// docx layouts are a zip, so the XML rules cannot run on them.
		const xmlFindings = isXml ? lintLayoutXml(xml, layout.filePath) : [];

		const parseError = xmlFindings.find((f) => f.rule === "xml-parse");
		if (parseError) {
			const error: BcError = { kind: "render", bcMessage: parseError.message };
			this.store.recordRender({
				layoutId: layout.id,
				contentHash,
				pdfPath: null,
				ok: false,
				error: parseError.message,
				durationMs: done(),
			});
			return {
				ok: false,
				layoutId: layout.id,
				error,
				durationMs: done(),
				lint: xmlFindings,
			};
		}

		if (!opts.force && state.currentHash === contentHash && state.currentPdf) {
			if (await Bun.file(state.currentPdf).exists()) {
				return {
					ok: true,
					layoutId: layout.id,
					pdfPath: state.currentPdf,
					pageCount: state.currentPageCount ?? 0,
					contentHash,
					durationMs: done(),
					lint: [...xmlFindings, ...(await this.#renderLint(state, xml))],
					cached: true,
				};
			}
		}

		const result = await this.transport(this.tokens, {
			connection,
			reportId: layout.reportNumber,
			reportParamsXml: layout.paramsXml ?? "",
			layoutBase64: Buffer.from(bytes).toString("base64"),
			layoutFormat: layoutFormatFor(layout.filePath),
		});

		if (!result.ok) {
			this.store.recordRender({
				layoutId: layout.id,
				contentHash,
				pdfPath: null,
				ok: false,
				error: JSON.stringify(result.error),
				durationMs: result.durationMs,
			});
			// A connection that authenticates tells us something the Settings screen wants.
			if (result.error.kind === "consent")
				this.store.setConnectionStatus(connection.id, "not_registered");
			if (result.error.kind === "auth")
				this.store.setConnectionStatus(connection.id, "forbidden");
			if (result.error.kind === "network")
				this.store.setConnectionStatus(connection.id, "unreachable");
			return {
				ok: false,
				layoutId: layout.id,
				error: result.error,
				durationMs: done(),
				lint: xmlFindings,
			};
		}

		this.store.setConnectionStatus(connection.id, "ok");

		const dir = `${this.workDir}/renders/${layout.id}`;
		await mkdir(dir, { recursive: true });
		const pdfPath = `${dir}/${contentHash}.pdf`;
		await Bun.write(pdfPath, result.pdf);

		if (state.currentPdf && state.currentPdf !== pdfPath) {
			state.previousPdf = state.currentPdf;
			state.previousGeometry = state.currentGeometry;
		}
		state.currentHash = contentHash;
		state.currentPdf = pdfPath;
		state.currentGeometry = undefined;

		const previousPageCount = state.currentPageCount;
		state.currentPageCount = await pageCount(pdfPath);

		const geo = await this.geometryOf(layout.id, "current");
		const findings = [
			...xmlFindings,
			...(geo
				? lintRender(geo, {
						previousPageCount,
						marginsPt: isXml ? pageMarginsFromXml(xml) : undefined,
					})
				: []),
		];

		this.store.recordRender({
			layoutId: layout.id,
			contentHash,
			pdfPath,
			ok: true,
			error: null,
			durationMs: result.durationMs,
		});

		return {
			ok: true,
			layoutId: layout.id,
			pdfPath,
			pageCount: state.currentPageCount,
			contentHash,
			durationMs: done(),
			lint: findings,
			cached: false,
		};
	}

	async #renderLint(state: LayoutState, xml: string): Promise<LintFinding[]> {
		if (!state.currentPdf) return [];
		const geo = await this.#geometry(state, "current");
		return geo
			? lintRender(geo, {
					marginsPt: xml ? pageMarginsFromXml(xml) : undefined,
				})
			: [];
	}

	async geometryOf(
		layoutId: string,
		which: "current" | "previous",
	): Promise<Geometry | undefined> {
		return this.#geometry(this.state(layoutId), which);
	}

	async #geometry(
		state: LayoutState,
		which: "current" | "previous",
	): Promise<Geometry | undefined> {
		if (which === "current") {
			if (state.currentGeometry) return state.currentGeometry;
			if (!state.currentPdf) return undefined;
			state.currentGeometry = await geometry(state.currentPdf);
			return state.currentGeometry;
		}
		if (state.previousGeometry) return state.previousGeometry;
		if (!state.previousPdf) return undefined;
		state.previousGeometry = await geometry(state.previousPdf);
		return state.previousGeometry;
	}
}
