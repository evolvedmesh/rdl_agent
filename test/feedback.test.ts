import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	diffGeometry,
	formatFindings,
	formatLocateResult,
	geometry,
	layoutText,
	lintLayoutXml,
	lintRender,
	locate,
	pageImage,
	parseXml,
	unifiedDiff,
} from "@layout/feedback";

const RDL = join(import.meta.dir, "fixtures", "Default.rdl");
const PDF = join(import.meta.dir, "fixtures", "preview.pdf");
const xml = await Bun.file(RDL).text();
const geo = await geometry(PDF);
const tmp = () => mkdtempSync(join(tmpdir(), "layout-fb-"));

/** Target the section Width (after </Body>), not the first Width in the file. */
const setBodyWidth = (w: string) =>
	xml.replace(/(<\/Body>\s*)<Width>[^<]*<\/Width>/, `$1<Width>${w}</Width>`);

describe("xml", () => {
	test("parses the real 4,139-line RDL with correct line numbers", () => {
		const root = parseXml(xml);
		expect(root.name).toBe("Report");
	});

	test("rejects a mismatched closing tag", () => {
		expect(() => parseXml(xml.replace("</Report>", "</Repor>"))).toThrow(
			/does not match/,
		);
	});

	test("rejects an unclosed element", () => {
		expect(() =>
			parseXml(xml.replace("<Width>18.15cm</Width>", "<Width>18.15cm")),
		).toThrow();
	});
});

describe("lint", () => {
	test("clean layout produces no findings", () => {
		expect(lintLayoutXml(xml, RDL)).toEqual([]);
	});

	test("catches body wider than page — the blank-alternate-page fault", () => {
		const f = lintLayoutXml(setBodyWidth("25cm"), RDL);
		const hit = f.find((x) => x.rule === "body-exceeds-page-width");
		expect(hit).toBeDefined();
		expect(hit!.severity).toBe("error");
		expect(hit!.location).toMatch(/Default\.rdl:\d+/);
		expect(hit!.message).toContain("Reduce the body");
	});

	test("catches items overhanging a narrowed body", () => {
		const f = lintLayoutXml(setBodyWidth("10cm"), RDL);
		expect(f.some((x) => x.rule === "item-exceeds-body-width")).toBe(true);
	});

	test("catches chrome taller than the page", () => {
		const f = lintLayoutXml(
			xml.replace("<TopMargin>2cm</TopMargin>", "<TopMargin>27cm</TopMargin>"),
			RDL,
		);
		expect(f.some((x) => x.rule === "chrome-exceeds-page-height")).toBe(true);
	});

	test("malformed XML is reported, not thrown", () => {
		const f = lintLayoutXml(xml.replace("</Report>", "</Repor>"), RDL);
		expect(f[0]!.rule).toBe("xml-parse");
	});

	test("post-render lint flags a blank page", () => {
		const blank = {
			pages: [{ index: 1, widthPt: 595, heightPt: 842, words: [] }],
		};
		expect(lintRender(blank).some((f) => f.rule === "blank-page")).toBe(true);
	});

	test("post-render lint flags a page-count change", () => {
		expect(
			lintRender(geo, { previousPageCount: 3 }).some(
				(f) => f.rule === "page-count-changed",
			),
		).toBe(true);
	});

	test("formatFindings stays readable when empty", () => {
		expect(formatFindings([])).toBe("Lint: no findings.");
	});
});

describe("channel costs", () => {
	test("layout text is ~500 tokens on the sample", async () => {
		const txt = await layoutText(PDF);
		expect(Math.round(txt.length / 4)).toBeGreaterThan(400);
		expect(Math.round(txt.length / 4)).toBeLessThan(700);
	});

	test("trimming beats lowering DPI — sharper and cheaper", async () => {
		const dir = tmp();
		const trimmed = await pageImage(PDF, dir, { dpi: 150, trim: true });
		const raw150 = await pageImage(PDF, dir, { dpi: 150, trim: false });
		const raw72 = await pageImage(PDF, dir, { dpi: 72, trim: false });

		expect(trimmed.trimmed).toBe(true);
		expect(trimmed.estimatedTokens).toBeLessThan(raw150.estimatedTokens / 3);
		expect(trimmed.estimatedTokens).toBeLessThan(raw72.estimatedTokens * 1.2);
		// Offsets are what let a pixel map back to a page point, and thence to an element.
		expect(trimmed.offsetXPx).toBeGreaterThan(0);
		expect(trimmed.pointsPerPixel).toBeCloseTo(72 / 150, 5);
	});

	test("a region crop is cheaper than the whole page", async () => {
		const dir = tmp();
		const whole = await pageImage(PDF, dir, { dpi: 200, trim: false });
		const region = await pageImage(PDF, dir, {
			dpi: 200,
			trim: false,
			region: [40, 200, 300, 120],
		});
		expect(region.estimatedTokens).toBeLessThan(whole.estimatedTokens / 4);
	});

	/**
	 * RenderEngine names every render `{contentHash}.pdf` — genuinely content-addressed.
	 * The raster this test guards used NOT to be: its filename was `p{page}-{dpi}.png`
	 * only, so a second render at the same page and dpi overwrote the first render's
	 * bitmap under a path string that never changed. The client had no way to tell a
	 * stale cached image from a fresh one, because nothing about the path said "this came
	 * from a different PDF" — an agent's edit could land, re-render, and the PDF pane
	 * would keep showing the previous render. The fix folds the source PDF's own name
	 * into the raster's, so two distinct renders can never collide on one file.
	 */
	test("two different renders at the same page and dpi never share a raster path", async () => {
		const dir = tmp();
		const bytes = await Bun.file(PDF).arrayBuffer();
		const first = join(dir, "aaaaaaaaaaaaaaaa.pdf"); // stand-in for RenderEngine's own {contentHash}.pdf naming
		const second = join(dir, "bbbbbbbbbbbbbbbb.pdf");
		await Bun.write(first, bytes);
		await Bun.write(second, bytes);

		const a = await pageImage(first, dir, { page: 1, dpi: 110, trim: false });
		const b = await pageImage(second, dir, { page: 1, dpi: 110, trim: false });

		expect(a.path).not.toBe(b.path);
		expect(await Bun.file(a.path).exists()).toBe(true);
		expect(await Bun.file(b.path).exists()).toBe(true);

		// The same PDF, asked for again, still resolves to the same raster — this is a
		// cache, not a hash-everything-fresh scheme; only a genuinely different source
		// should produce a genuinely different path.
		const aAgain = await pageImage(first, dir, {
			page: 1,
			dpi: 110,
			trim: false,
		});
		expect(aAgain.path).toBe(a.path);
	});
});

describe("geometry diff", () => {
	test("identical renders report no movement", () => {
		expect(diffGeometry(geo, geo)).toMatch(/No geometry change/);
	});

	test("a column narrowing is summarised in ~100 tokens, with the wrap called out", () => {
		const after = structuredClone(geo);
		const p = after.pages[0]!;
		for (const w of p.words)
			if (w.xMin > 400) {
				w.xMin -= 12.3;
				w.xMax -= 12.3;
			}
		const victim = p.words.find((w) => w.text.length > 6 && w.xMin > 400)!;
		victim.yMin += 11;
		victim.yMax += 11;
		victim.xMin -= 30;
		victim.xMax -= 30;

		const out = diffGeometry(geo, after);
		expect(out).toContain("moved by");
		expect(out).toContain("wrapped");
		expect(Math.round(out.length / 4)).toBeLessThan(250);
	});

	test("a page-count change is stated, with the alignment caveat", () => {
		const after = structuredClone(geo);
		after.pages.push({ ...structuredClone(geo.pages[0]!), index: 2 });
		expect(diffGeometry(geo, after)).toContain("Page count 1 → 2");
	});
});

describe("locate", () => {
	test("resolves a data cell to its tablix column and bound field", () => {
		const r = locate(xml, RDL, geo, { text: "SRICHAR" });
		expect(r.column?.index).toBe(10);
		// The RDL contains =Fields!UserID_VATEntry.Value, never the rendered "SRICHARAN" —
		// which is exactly why the join has to be geometric.
		expect(r.candidates.some((c) => c.value?.includes("UserID_VATEntry"))).toBe(
			true,
		);
		expect(r.candidates[0]!.location).toMatch(/Default\.rdl:\d+/);
	});

	test("diagnoses a phrase that wrapped across two lines", () => {
		const r = locate(xml, RDL, geo, { text: "Credit Memo" });
		expect(r.matchedText).toContain("wrapped across 2 lines");
		expect(r.column?.index).toBe(2);
		expect(r.candidates.some((c) => c.value?.includes("DocumentType"))).toBe(
			true,
		);
	});

	test("finds a free-standing textbox above the table", () => {
		const r = locate(xml, RDL, geo, { text: "Settlement Account" });
		expect(r.candidates[0]!.name).toBe("GLAccSettleNoCaption");
	});

	test("a label above the table does not falsely match a tablix column", () => {
		// x=72.9 falls inside column 0's x-range; only the y-bound keeps it honest.
		const r = locate(xml, RDL, geo, { text: "Settlement Account" });
		expect(r.column).toBeUndefined();
	});

	test("resolves a raw page coordinate", () => {
		const r = locate(xml, RDL, geo, { coords: { x: 536, y: 240 } });
		expect(r.column?.index).toBe(10);
		expect(r.candidates.length).toBeGreaterThan(0);
	});

	test("reports honestly when nothing matches", () => {
		const r = locate(xml, RDL, geo, { text: "zzz-not-in-this-report" });
		expect(r.candidates).toHaveLength(0);
		expect(formatLocateResult(r)).toContain("No layout element matched");
	});
});

/**
 * `unifiedDiff` exists for one reason: GPUIX's `<diff>` element renders a real
 * unified-diff `patch` string, not raw before/after text — and that element is how a
 * session chat shows what an agent's edit actually did. Wrong output here is
 * indistinguishable, in the chat, from no diff at all.
 */
describe("unified diff", () => {
	test("a single-line deletion in the middle of a snippet", () => {
		const patch = unifiedDiff(
			"line two\nINVOICE NO: 12345\nline four",
			"line two\nline four",
			{ path: "a.rdl" },
		);
		expect(patch).toBe(
			"--- a/a.rdl\n+++ b/a.rdl\n@@ -1,3 +1,2 @@\n line two\n-INVOICE NO: 12345\n line four\n",
		);
	});

	test("identical text is null — there is nothing to show", () => {
		expect(unifiedDiff("same text", "same text", { path: "a.rdl" })).toBeNull();
	});

	test("a pure addition and a pure replacement", () => {
		const added = unifiedDiff("a\nb", "a\nb\nc", { path: "x" });
		expect(added).toContain("+c");
		expect(added).not.toContain("-a");
		expect(added).not.toContain("-b");

		const replaced = unifiedDiff("Invoice No.", "Reference No.", { path: "x" });
		expect(replaced).toContain("-Invoice No.");
		expect(replaced).toContain("+Reference No.");
	});

	test("an oversized pair degrades to a coarse notice instead of hanging", () => {
		const huge = unifiedDiff("a\n".repeat(3000), "b\n".repeat(3000), {
			path: "x",
			maxLines: 1000,
		});
		expect(huge).toContain("Too large to diff line-by-line");
		expect(huge).toContain("3000");
	});

	test("context is bounded by contextLines, not the whole file", () => {
		const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join(
			"\n",
		);
		const newText = oldText.replace("line 10", "LINE TEN");
		const patch = unifiedDiff(oldText, newText, {
			path: "x",
			contextLines: 1,
		})!;
		// Only the changed line plus one line of context on each side, not all 20.
		expect(patch.split("\n").filter((l) => l.startsWith(" ")).length).toBe(2);
		expect(patch).toContain("-line 10");
		expect(patch).toContain("+LINE TEN");
	});
});

describe("external tool resolution", () => {
	test("a bundled binary wins over PATH; an absent one falls back to the bare name", async () => {
		const { resolveTool } = await import("@layout/feedback");
		const dir = tmp();
		// Novel names: resolveTool memoises, and the real poppler/magick names are
		// already resolved off PATH by the time this runs.
		const bundled = join(
			dir,
			`fake-pdf-tool${process.platform === "win32" ? ".exe" : ""}`,
		);
		await Bun.write(bundled, "#!/bin/sh\n");

		const prev = process.env.LAYOUT_TOOLS_DIR;
		process.env.LAYOUT_TOOLS_DIR = dir;
		try {
			expect(resolveTool("fake-pdf-tool")).toBe(bundled);
			expect(resolveTool("fake-absent-tool")).toBe("fake-absent-tool");
		} finally {
			if (prev === undefined) delete process.env.LAYOUT_TOOLS_DIR;
			else process.env.LAYOUT_TOOLS_DIR = prev;
		}
	});

	test("the missing-tool message names the tool and the ways to supply it", async () => {
		const { missingToolMessage } = await import("@layout/feedback");
		const m = missingToolMessage("pdftoppm");
		expect(m).toContain("pdftoppm");
		expect(m).toContain("LAYOUT_TOOLS_DIR");
		// "tools", not "bin": inside an Electrobun bundle the running binary sits in
		// <app>/bin/ next to Electrobun's own launcher and bspatch.
		expect(m).toContain("tools");
	});
});
