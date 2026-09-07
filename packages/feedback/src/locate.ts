/**
 * Anchoring: given a page coordinate or a piece of rendered text, find the layout
 * element that produced it.
 *
 * This is the piece that decides whether the loop converges. Seeing a defect is easy;
 * mapping it back to one of 120 textboxes across 4,139 lines of XML is the step that
 * otherwise dominates the iteration count, because without help the agent greps and
 * guesses.
 *
 * The join is geometric, not textual. A tablix's column widths are declared in the RDL,
 * so cumulative widths give every column an x-range in page points — and a rendered word
 * at x=783 falls in exactly one of them. That works for data cells, where the RDL only
 * contains `=Fields!UserID.Value` and the rendered text is "SRICHARAN", which no amount
 * of string matching would connect.
 */

import { toPoints } from "./lint.ts";
import type { Geometry, Word } from "./pdf.ts";
import { child, childText, findAll, parseXml, type XmlNode } from "./xml.ts";

export type LocatedElement = {
	/** RDL element name, e.g. the Textbox's Name attribute. */
	name: string;
	/** `file:line`, ready to paste into an editor. */
	location: string;
	line: number;
	/** Where this element sits in the layout tree, for orientation. */
	path: string;
	/** The Value expression, so the agent can tell a caption from a bound field. */
	value?: string;
	widthCm?: number;
	canGrow?: boolean;
	/** Why this element was chosen — geometric, literal or field match. */
	reason: string;
	confidence: "high" | "medium" | "low";
};

export type LocateResult = {
	query: string;
	/** The rendered words the query resolved to, if any. */
	matchedText?: string;
	pageCoords?: { x: number; y: number };
	candidates: LocatedElement[];
	/** Column context when the hit landed inside a tablix. */
	column?: {
		index: number;
		header?: string;
		xRange: [number, number];
		widthCm: number;
	};
};

type Column = {
	index: number;
	/** Page points, absolute. */
	xMin: number;
	xMax: number;
	widthPt: number;
	/** Textboxes found in this column, in row order — header row first in practice. */
	cells: XmlNode[];
};

type TablixInfo = {
	node: XmlNode;
	name: string;
	columns: Column[];
	/** Declared top edge in page points. A tablix grows downward, so only the top is firm. */
	topPt: number;
	/** Declared height. Rows can grow past it, so this is a floor, not a ceiling. */
	declaredHeightPt: number;
};

const cm = (pt: number) => Number((pt / (72 / 2.54)).toFixed(3));

const LINE_BAND = 2.0; // points; words within this yMin band render on the same line

/**
 * Resolve a query string to a bounding box on the page.
 *
 * Single words are the common case, but "Settlement Account" and "Credit Memo" are the
 * queries a person actually types, so a phrase has to match across consecutive words on
 * a line. Falls back to a substring hit on one word.
 */
function findTextSpan(
	words: Word[],
	query: string,
):
	| { text: string; xMin: number; yMin: number; xMax: number; yMax: number }
	| undefined {
	const needle = query.trim().toLowerCase();
	if (!needle) return undefined;

	const exact = words.find((w) => w.text.toLowerCase() === needle);
	if (exact) return { ...exact };

	// Group into lines, then slide a window of consecutive words over each.
	const sorted = [...words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
	const lines: Word[][] = [];
	for (const w of sorted) {
		const last = lines[lines.length - 1];
		const lastHead = last?.[0];
		if (lastHead && Math.abs(w.yMin - lastHead.yMin) <= LINE_BAND) last.push(w);
		else lines.push([w]);
	}

	const terms = needle.split(/\s+/);
	for (const line of lines) {
		line.sort((a, b) => a.xMin - b.xMin);
		for (let i = 0; i + terms.length <= line.length; i++) {
			const window = line.slice(i, i + terms.length);
			if (!window.every((w, k) => w.text.toLowerCase() === terms[k])) continue;
			return {
				text: window.map((w) => w.text).join(" "),
				xMin: Math.min(...window.map((w) => w.xMin)),
				yMin: Math.min(...window.map((w) => w.yMin)),
				xMax: Math.max(...window.map((w) => w.xMax)),
				yMax: Math.max(...window.map((w) => w.yMax)),
			};
		}
	}

	// A phrase that wrapped is exactly the phrase someone asks about, so look for its
	// terms continuing on the next line within the same column band before giving up.
	if (terms.length > 1) {
		for (const [li, line] of lines.entries()) {
			const next = lines[li + 1];
			if (!next) continue;
			for (let i = 0; i < line.length; i++) {
				const word = line[i];
				if (!word || word.text.toLowerCase() !== terms[0]) continue;
				const head = line.slice(i, i + terms.length);
				const consumed = head.filter(
					(w, k) => w.text.toLowerCase() === terms[k],
				);
				const remaining = terms.slice(consumed.length);
				if (remaining.length === 0 || consumed.length === 0) continue;
				const tail = next.filter((w) =>
					remaining.includes(w.text.toLowerCase()),
				);
				if (tail.length !== remaining.length) continue;
				// Same column: the continuation must start near the phrase's own x-range.
				const headMinX = Math.min(...consumed.map((w) => w.xMin));
				const headMaxX = Math.max(...consumed.map((w) => w.xMax));
				const tailX = Math.min(...tail.map((w) => w.xMin));
				if (tailX < headMinX - 40 || tailX > headMaxX + 40) continue;
				const all = [...consumed, ...tail];
				return {
					text: `${consumed.map((w) => w.text).join(" ")} / ${tail.map((w) => w.text).join(" ")} (wrapped across 2 lines)`,
					xMin: Math.min(...all.map((w) => w.xMin)),
					yMin: Math.min(...all.map((w) => w.yMin)),
					xMax: Math.max(...all.map((w) => w.xMax)),
					yMax: Math.max(...all.map((w) => w.yMax)),
				};
			}
		}
	}

	const partial = words.find((w) => w.text.toLowerCase().includes(needle));
	return partial ? { ...partial } : undefined;
}

/**
 * Top-left of the body in page coordinates.
 *
 * The body does not start at the top margin: the page header sits above it, so its
 * height has to be added or every vertical comparison is off by ~45pt — enough to put a
 * hit in the wrong element or in none at all.
 */
function bodyOriginPt(root: XmlNode): { left: number; top: number } {
	const section = findAll(root, "ReportSection")[0];
	const page = section ? child(section, "Page") : undefined;
	const headerHeight = page
		? (toPoints(childText(child(page, "PageHeader") ?? page, "Height")) ?? 0)
		: 0;
	return {
		left: toPoints(childText(page ?? section ?? root, "LeftMargin")) ?? 0,
		top:
			(toPoints(childText(page ?? section ?? root, "TopMargin")) ?? 0) +
			headerHeight,
	};
}

/** Absolute Left of a node by summing Left through its container ancestors. */
function absoluteLeft(node: XmlNode, originLeft: number): number {
	let x = originLeft;
	let cur: XmlNode | undefined = node;
	while (cur) {
		const own = toPoints(childText(cur, "Left"));
		if (own !== undefined) x += own;
		cur = cur.parent;
	}
	return x;
}

/** Absolute Top, same walk. */
function absoluteTop(node: XmlNode, originTop: number): number {
	let y = originTop;
	let cur: XmlNode | undefined = node;
	while (cur) {
		const own = toPoints(childText(cur, "Top"));
		if (own !== undefined) y += own;
		cur = cur.parent;
	}
	return y;
}

function textboxesIn(cell: XmlNode): XmlNode[] {
	return findAll(cell, "Textbox");
}

/**
 * Build each tablix's column geometry from its declared TablixColumn widths.
 * Cells are collected per column index across all rows, which is what lets a coordinate
 * resolve to both the header textbox and the detail textbox of the same column.
 */
function tablixColumns(
	root: XmlNode,
	originLeft: number,
	originTop: number,
): TablixInfo[] {
	const out: TablixInfo[] = [];

	for (const tablix of findAll(root, "Tablix")) {
		const body = child(tablix, "TablixBody");
		if (!body) continue;
		const colDefs = child(body, "TablixColumns");
		if (!colDefs) continue;

		const widths = colDefs.children
			.filter((c) => c.name === "TablixColumn")
			.map((c) => toPoints(childText(c, "Width")) ?? 0);
		if (widths.length === 0) continue;

		const startX = absoluteLeft(tablix, originLeft);
		const columns: Column[] = [];
		let x = startX;
		for (const [index, w] of widths.entries()) {
			columns.push({ index, xMin: x, xMax: x + w, widthPt: w, cells: [] });
			x += w;
		}

		const rows = child(body, "TablixRows");
		for (const row of rows
			? rows.children.filter((c) => c.name === "TablixRow")
			: []) {
			const cells = child(row, "TablixCells");
			if (!cells) continue;
			const cellNodes = cells.children.filter((c) => c.name === "TablixCell");
			for (const [index, cellNode] of cellNodes.entries()) {
				const col = columns[index];
				if (col) col.cells.push(...textboxesIn(cellNode));
			}
		}

		out.push({
			node: tablix,
			name: tablix.attrs.Name ?? "Tablix",
			columns,
			topPt: absoluteTop(tablix, originTop),
			declaredHeightPt: toPoints(childText(tablix, "Height")) ?? 0,
		});
	}

	return out;
}

function describe(
	node: XmlNode,
	filePath: string,
	reason: string,
	confidence: LocatedElement["confidence"],
): LocatedElement {
	const width = toPoints(childText(node, "Width"));
	const canGrow = childText(node, "CanGrow");
	const parts: string[] = [];
	let cur: XmlNode | undefined = node;
	while (cur) {
		parts.unshift(cur.attrs.Name ? `${cur.name}[${cur.attrs.Name}]` : cur.name);
		cur = cur.parent;
	}
	return {
		name: node.attrs.Name ?? node.name,
		location: `${filePath}:${node.line}`,
		line: node.line,
		path: parts.slice(-6).join(" / "),
		value:
			childText(child(node, "Paragraphs") ?? node, "Value") ?? findValue(node),
		widthCm: width === undefined ? undefined : cm(width),
		canGrow: canGrow === undefined ? undefined : canGrow === "true",
		reason,
		confidence,
	};
}

/** A Textbox's text is buried under Paragraphs/Paragraph/TextRuns/TextRun/Value. */
function findValue(node: XmlNode): string | undefined {
	for (const v of findAll(node, "Value")) {
		if (v.text) return v.text;
	}
	return undefined;
}

export type LocateOptions = {
	/** 1-based. Defaults to page 1. */
	page?: number;
	/** Page-point coordinate. Either this or `text` is required. */
	coords?: { x: number; y: number };
	text?: string;
	maxCandidates?: number;
};

export function locate(
	layoutXml: string,
	filePath: string,
	geometry: Geometry,
	opts: LocateOptions,
): LocateResult {
	const root = parseXml(layoutXml);
	const origin = bodyOriginPt(root);
	const pageIndex = (opts.page ?? 1) - 1;
	const page = geometry.pages[pageIndex];
	const max = opts.maxCandidates ?? 5;

	const result: LocateResult = {
		query: opts.text ?? JSON.stringify(opts.coords),
		candidates: [],
	};

	// Resolve the query to a point on the page.
	let point = opts.coords;
	if (opts.text !== undefined && page) {
		const span = findTextSpan(page.words, opts.text);
		if (span) {
			point = {
				x: (span.xMin + span.xMax) / 2,
				y: (span.yMin + span.yMax) / 2,
			};
			result.matchedText = span.text;
		}
	}
	if (point) result.pageCoords = point;

	// 1. Literal match: static captions carry their text in the RDL verbatim, so when it
	//    works this is unambiguous and worth preferring over geometry.
	if (opts.text) {
		const needle = opts.text.trim().toLowerCase();
		for (const tb of findAll(root, "Textbox")) {
			const value = findValue(tb);
			if (!value || value.startsWith("=")) continue;
			if (value.toLowerCase() === needle) {
				result.candidates.push(
					describe(
						tb,
						filePath,
						`static text "${value}" matches exactly`,
						"high",
					),
				);
			} else if (value.toLowerCase().includes(needle) && needle.length > 3) {
				result.candidates.push(
					describe(
						tb,
						filePath,
						`static text "${value}" contains the query`,
						"medium",
					),
				);
			}
		}
	}

	// 2. Geometry: which tablix column contains the point.
	if (point) {
		for (const tablix of tablixColumns(root, origin.left, origin.top)) {
			// Vertical bound matters: without it a label sitting above the table, but in the
			// same x-band as column 0, matches that column with full confidence and sends the
			// agent to edit the wrong element.
			if (point.y < tablix.topPt - LINE_BAND) continue;
			const px = point.x;
			const col = tablix.columns.find((c) => px >= c.xMin && px < c.xMax);
			if (!col) continue;

			result.column = {
				index: col.index,
				xRange: [Number(col.xMin.toFixed(1)), Number(col.xMax.toFixed(1))],
				widthCm: cm(col.widthPt),
			};

			// The header is the first cell in the column whose value is a literal.
			const header = col.cells.find((c) => {
				const v = findValue(c);
				return v !== undefined && !v.startsWith("=");
			});
			if (header) result.column.header = findValue(header);

			for (const cellNode of col.cells) {
				result.candidates.push(
					describe(
						cellNode,
						filePath,
						`in ${tablix.name} column ${col.index} (x ${col.xMin.toFixed(0)}–${col.xMax.toFixed(0)}pt, width ${cm(col.widthPt)}cm)`,
						"high",
					),
				);
			}
			break;
		}

		// 3. Free-standing textboxes in the body whose declared box contains the point.
		if (result.candidates.length === 0) {
			for (const tb of findAll(root, "Textbox")) {
				if (tb.parent?.name === "CellContents") continue; // handled by the tablix pass
				const left = absoluteLeft(tb, origin.left);
				const top = (toPoints(childText(tb, "Top")) ?? 0) + origin.top;
				const w = toPoints(childText(tb, "Width")) ?? 0;
				const h = toPoints(childText(tb, "Height")) ?? 0;
				if (
					point.x >= left &&
					point.x <= left + w &&
					point.y >= top &&
					point.y <= top + h
				) {
					result.candidates.push(
						describe(tb, filePath, "declared box contains the point", "medium"),
					);
				}
			}
		}
	}

	const rank = { high: 0, medium: 1, low: 2 };
	result.candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

	// De-duplicate by line: the same textbox can match on both text and geometry.
	const seen = new Set<number>();
	result.candidates = result.candidates
		.filter((c) => {
			if (seen.has(c.line)) return false;
			seen.add(c.line);
			return true;
		})
		.slice(0, max);

	return result;
}

export function formatLocateResult(r: LocateResult): string {
	const lines: string[] = [];
	lines.push(`Query: ${r.query}`);
	if (r.matchedText) lines.push(`Matched rendered text: "${r.matchedText}"`);
	if (r.pageCoords)
		lines.push(
			`At page point (${r.pageCoords.x.toFixed(1)}, ${r.pageCoords.y.toFixed(1)})`,
		);
	if (r.column) {
		lines.push(
			`Tablix column ${r.column.index}` +
				(r.column.header ? ` — header "${r.column.header}"` : "") +
				` — x ${r.column.xRange[0]}–${r.column.xRange[1]}pt, declared width ${r.column.widthCm}cm`,
		);
	}
	if (r.candidates.length === 0) {
		lines.push("");
		lines.push(
			"No layout element matched. Try a page coordinate from layout_page_image, or a distinctive word from layout_text.",
		);
		return lines.join("\n");
	}
	lines.push("");
	for (const c of r.candidates) {
		lines.push(`${c.name}  (${c.confidence})  ${c.location}`);
		lines.push(`  ${c.path}`);
		if (c.value !== undefined) lines.push(`  value: ${c.value.slice(0, 120)}`);
		const attrs: string[] = [];
		if (c.widthCm !== undefined) attrs.push(`Width=${c.widthCm}cm`);
		if (c.canGrow !== undefined) attrs.push(`CanGrow=${c.canGrow}`);
		if (attrs.length) lines.push(`  ${attrs.join(", ")}`);
		lines.push(`  why: ${c.reason}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
