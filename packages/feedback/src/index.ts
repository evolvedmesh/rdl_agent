/**
 * The feedback ladder, cheapest channel first.
 *
 *   errors   free      BC's own message, structured (packages/core)
 *   lint     free      deterministic rules, pre-render from XML and post-render
 *   text     ~500 tok  pdftotext -layout
 *   diff     ~100 tok  geometry deltas computed here, never sent raw
 *   pixels   ~750 tok  trimmed page raster, on demand
 *   locate   free      rendered position -> the element that produced it
 */

export { missingToolMessage, resolveTool } from "./bin.ts";
export type { DiffOptions } from "./diff.ts";
export { diffGeometry } from "./diff.ts";
export type { LintFinding } from "./lint.ts";
export { formatFindings, lintLayoutXml, lintRender, toPoints } from "./lint.ts";
export type { LocatedElement, LocateOptions, LocateResult } from "./locate.ts";
export { formatLocateResult, locate } from "./locate.ts";
export type {
	Geometry,
	Page,
	PageImage,
	PageImageOptions,
	Word,
} from "./pdf.ts";
export { geometry, layoutText, pageCount, pageImage } from "./pdf.ts";
export type { UnifiedDiffOptions } from "./unified-diff.ts";
export { unifiedDiff } from "./unified-diff.ts";
export type { XmlNode } from "./xml.ts";
export {
	child,
	children,
	childText,
	decodeXmlText,
	descendants,
	findAll,
	parseXml,
	pathOf,
	XmlError,
} from "./xml.ts";
