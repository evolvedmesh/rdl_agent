/**
 * Channel 1: deterministic lint. Zero tokens, no model.
 *
 * These are defects that need no judgement at all, so they must never cost a token —
 * and they are more reliable than hoping a model notices. The pre-render rules run on
 * the XML alone, which means the classic "every second page is blank" bug is caught
 * before spending a BC round trip.
 */

import type { Geometry } from "./pdf.ts";
import { child, childText, findAll, parseXml, type XmlNode } from "./xml.ts";

export type LintFinding = {
	rule: string;
	severity: "error" | "warning" | "info";
	message: string;
	/** `file:line` where known — this is what stops the agent grepping 4,139 lines. */
	location?: string;
};

/** RDL sizes are a number plus a unit. Everything internal is points. */
const UNITS_PER_POINT: Record<string, number> = {
	in: 72,
	cm: 72 / 2.54,
	mm: 72 / 25.4,
	pt: 1,
	pc: 12,
};

export function toPoints(size: string | undefined): number | undefined {
	if (!size) return undefined;
	const m = /^\s*(-?[\d.]+)\s*(in|cm|mm|pt|pc)\s*$/i.exec(size);
	if (!m) return undefined;
	const unit = m[2];
	const factor = unit ? UNITS_PER_POINT[unit.toLowerCase()] : undefined;
	return factor === undefined ? undefined : Number(m[1]) * factor;
}

const fmt = (pt: number) => `${(pt / (72 / 2.54)).toFixed(2)}cm`;
/** Sub-point differences are rounding, not defects. */
const EPS = 0.5;

type Rect = {
	name: string;
	left: number;
	top: number;
	width: number;
	height: number;
	line: number;
};

function rectOf(node: XmlNode): Rect | undefined {
	const width = toPoints(childText(node, "Width"));
	const height = toPoints(childText(node, "Height"));
	if (width === undefined || height === undefined) return undefined;
	return {
		name: node.attrs.Name ?? node.name,
		left: toPoints(childText(node, "Left")) ?? 0,
		top: toPoints(childText(node, "Top")) ?? 0,
		width,
		height,
		line: node.line,
	};
}

/** Pre-render lint: the XML only. Free, and it runs before any BC call. */
export function lintLayoutXml(xml: string, filePath: string): LintFinding[] {
	const findings: LintFinding[] = [];
	const at = (line: number) => `${filePath}:${line}`;

	let root: XmlNode;
	try {
		root = parseXml(xml);
	} catch (e) {
		return [
			{
				rule: "xml-parse",
				severity: "error",
				message: `Layout is not well-formed XML: ${e}`,
			},
		];
	}

	const sections = findAll(root, "ReportSection");
	if (sections.length === 0) {
		return [
			{
				rule: "no-report-section",
				severity: "error",
				message: "No <ReportSection> found",
			},
		];
	}

	for (const [n, section] of sections.entries()) {
		const label = sections.length > 1 ? ` (section ${n + 1})` : "";
		const page = child(section, "Page");
		const bodyWidth = toPoints(childText(section, "Width"));
		if (!page || bodyWidth === undefined) continue;

		// Absent margin elements default to 0 in RDL — this layout genuinely omits
		// <RightMargin>, so treating "missing" as an error would be wrong.
		const pageWidth = toPoints(childText(page, "PageWidth"));
		const pageHeight = toPoints(childText(page, "PageHeight"));
		const left = toPoints(childText(page, "LeftMargin")) ?? 0;
		const right = toPoints(childText(page, "RightMargin")) ?? 0;
		const top = toPoints(childText(page, "TopMargin")) ?? 0;
		const bottom = toPoints(childText(page, "BottomMargin")) ?? 0;

		if (pageWidth !== undefined) {
			const used = left + bodyWidth + right;
			if (used > pageWidth + EPS) {
				findings.push({
					rule: "body-exceeds-page-width",
					severity: "error",
					message:
						`Body width + margins is ${fmt(used)} but the page is only ${fmt(pageWidth)} wide` +
						`${label} (left ${fmt(left)} + body ${fmt(bodyWidth)} + right ${fmt(right)}). ` +
						`This is the classic RDL fault that makes every second page blank. ` +
						`Reduce the body <Width> by at least ${fmt(used - pageWidth)}.`,
					location: at(section.line),
				});
			} else if (used > pageWidth - 2 && used <= pageWidth + EPS) {
				findings.push({
					rule: "body-near-page-width",
					severity: "info",
					message: `Body + margins (${fmt(used)}) is within 2pt of the page width (${fmt(pageWidth)})${label}; any widening will overflow.`,
					location: at(section.line),
				});
			}
		}

		if (pageHeight !== undefined) {
			const headerH =
				toPoints(childText(child(page, "PageHeader") ?? section, "Height")) ??
				0;
			const footerH =
				toPoints(childText(child(page, "PageFooter") ?? section, "Height")) ??
				0;
			const chrome = top + bottom + headerH + footerH;
			if (chrome > pageHeight + EPS) {
				findings.push({
					rule: "chrome-exceeds-page-height",
					severity: "error",
					message: `Margins + page header + page footer total ${fmt(chrome)}, taller than the ${fmt(pageHeight)} page${label}; no room is left for the body.`,
					location: at(page.line),
				});
			}
		}

		const body = child(section, "Body");
		const items = body ? child(body, "ReportItems") : undefined;
		if (!items) continue;

		const rects = items.children
			.map(rectOf)
			.filter((r): r is Rect => r !== undefined);

		for (const r of rects) {
			if (r.left + r.width > bodyWidth + EPS) {
				findings.push({
					rule: "item-exceeds-body-width",
					severity: "error",
					message:
						`"${r.name}" ends at ${fmt(r.left + r.width)} but the body is ${fmt(bodyWidth)} wide; ` +
						`it overhangs by ${fmt(r.left + r.width - bodyWidth)} and will be clipped or pushed to an overflow page.`,
					location: at(r.line),
				});
			}
			if (r.left < -EPS || r.top < -EPS) {
				findings.push({
					rule: "item-negative-position",
					severity: "warning",
					message: `"${r.name}" is positioned at (${fmt(r.left)}, ${fmt(r.top)}), partly off the body.`,
					location: at(r.line),
				});
			}
		}

		// Siblings only: overlap between items in different containers is not comparable
		// without resolving each container's own coordinate origin.
		for (let a = 0; a < rects.length; a++) {
			for (let b = a + 1; b < rects.length; b++) {
				const ra = rects[a];
				const rb = rects[b];
				if (!ra || !rb) continue;
				const ox =
					Math.min(ra.left + ra.width, rb.left + rb.width) -
					Math.max(ra.left, rb.left);
				const oy =
					Math.min(ra.top + ra.height, rb.top + rb.height) -
					Math.max(ra.top, rb.top);
				if (ox > EPS && oy > EPS) {
					findings.push({
						rule: "items-overlap",
						severity: "warning",
						message: `"${ra.name}" and "${rb.name}" overlap by ${fmt(ox)} × ${fmt(oy)}.`,
						location: at(ra.line),
					});
				}
			}
		}
	}

	return findings;
}

/** Post-render lint: what the rendered PDF says. Still free. */
export function lintRender(
	geo: Geometry,
	opts: {
		previousPageCount?: number;
		marginsPt?: { left: number; right: number; top: number; bottom: number };
	} = {},
): LintFinding[] {
	const findings: LintFinding[] = [];

	if (
		opts.previousPageCount !== undefined &&
		opts.previousPageCount !== geo.pages.length
	) {
		findings.push({
			rule: "page-count-changed",
			severity: "warning",
			message: `Page count changed from ${opts.previousPageCount} to ${geo.pages.length}.`,
		});
	}

	for (const page of geo.pages) {
		if (page.words.length === 0) {
			findings.push({
				rule: "blank-page",
				severity: "error",
				message:
					`Page ${page.index} contains no text. Alternating blank pages almost always ` +
					`mean the body plus margins are wider than the paper.`,
			});
			continue;
		}

		const m = opts.marginsPt;
		if (!m) continue;
		const overhang = page.words.filter(
			(w) =>
				w.xMin < m.left - EPS ||
				w.xMax > page.widthPt - m.right + EPS ||
				w.yMin < m.top - EPS ||
				w.yMax > page.heightPt - m.bottom + EPS,
		);
		if (overhang.length > 0) {
			const worst = overhang.reduce((a, w) => (w.xMax > a.xMax ? w : a));
			findings.push({
				rule: "content-outside-margins",
				severity: "warning",
				message:
					`${overhang.length} word(s) on page ${page.index} fall outside the printable area; ` +
					`the furthest is "${worst.text}" ending at x=${worst.xMax.toFixed(1)}pt ` +
					`(right margin starts at ${(page.widthPt - m.right).toFixed(1)}pt).`,
			});
		}
	}

	return findings;
}

export function formatFindings(findings: LintFinding[]): string {
	if (findings.length === 0) return "Lint: no findings.";
	return findings
		.map(
			(f) =>
				`[${f.severity}] ${f.rule}${f.location ? ` (${f.location})` : ""}: ${f.message}`,
		)
		.join("\n");
}
