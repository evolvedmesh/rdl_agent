/**
 * PDF feedback primitives: the channels of the ladder that read a rendered page.
 *
 * All of these shell out to poppler + ImageMagick. They come off PATH in dev; a packaged
 * build resolves them via `resolveTool` (see bin.ts) so a portable bundle works too.
 * Nothing here holds state; the caller owns the files.
 */
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { missingToolMessage, resolveTool } from "./bin.ts";

export type Word = {
	text: string;
	/** Points, origin top-left — the same frame pdftotext -bbox-layout reports. */
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
};

export type Page = {
	index: number; // 1-based
	widthPt: number;
	heightPt: number;
	words: Word[];
};

export type Geometry = { pages: Page[] };

async function run(cmd: string[]): Promise<string> {
	const [name, ...rest] = cmd as [string, ...string[]];
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([resolveTool(name), ...rest], {
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (e) {
		// ENOENT here means the binary is not on PATH and not bundled — say so plainly.
		const code = (e as { code?: string }).code;
		throw new Error(code === "ENOENT" ? missingToolMessage(name) : String(e));
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(
			`${name} exited ${code}: ${stderr.trim() || stdout.trim()}`,
		);
	}
	return stdout;
}

export async function pageCount(pdfPath: string): Promise<number> {
	const info = await run(["pdfinfo", pdfPath]);
	const m = /^Pages:\s+(\d+)$/m.exec(info);
	if (!m) throw new Error("pdfinfo did not report a page count");
	return Number(m[1]);
}

/** Channel 2: layout text. ~500 tokens on the sample, and catches real defects. */
export async function layoutText(
	pdfPath: string,
	page?: number,
): Promise<string> {
	const args = ["pdftotext", "-layout"];
	if (page !== undefined) args.push("-f", String(page), "-l", String(page));
	args.push(pdfPath, "-");
	return run(args);
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&apos;": "'",
};

function decodeEntities(s: string): string {
	return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Channel 3 input: every word's bbox. 25,900 characters on the sample — this is the
 * thing that must NEVER be sent to a model raw. It exists to be diffed in code.
 */
export async function geometry(pdfPath: string): Promise<Geometry> {
	const xml = await run(["pdftotext", "-bbox-layout", pdfPath, "-"]);
	const pages: Page[] = [];

	const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
	const wordRe =
		/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([\s\S]*?)<\/word>/g;

	let index = 0;
	let pm = pageRe.exec(xml);
	while (pm !== null) {
		index += 1;
		const inner = pm[3] ?? "";
		const words: Word[] = [];
		wordRe.lastIndex = 0;
		let wm = wordRe.exec(inner);
		while (wm !== null) {
			words.push({
				xMin: Number(wm[1]),
				yMin: Number(wm[2]),
				xMax: Number(wm[3]),
				yMax: Number(wm[4]),
				text: decodeEntities(wm[5] ?? ""),
			});
			wm = wordRe.exec(inner);
		}
		pages.push({
			index,
			widthPt: Number(pm[1]),
			heightPt: Number(pm[2]),
			words,
		});
		pm = pageRe.exec(xml);
	}

	return { pages };
}

export type PageImage = {
	path: string;
	widthPx: number;
	heightPx: number;
	dpi: number;
	/** Pixel offset of the returned image within the full page raster. */
	offsetXPx: number;
	offsetYPx: number;
	/** Multiply a pixel coordinate by this and add the offset to get page points. */
	pointsPerPixel: number;
	estimatedTokens: number;
	trimmed: boolean;
};

export type PageImageOptions = {
	page?: number;
	dpi?: number;
	/** [x, y, w, h] in points, origin top-left, applied before trimming. */
	region?: [number, number, number, number];
	/**
	 * Trim whitespace to content. Default true: on the sample this is ~726 tokens versus
	 * ~2,902 untrimmed at the same DPI — and sharper than dropping to 72 dpi to save the
	 * same tokens. Crop, don't downscale.
	 *
	 * Set false when judging margins: trimming crops away the very whitespace that makes
	 * a margin overflow visible.
	 */
	trim?: boolean;
	/** White border kept around trimmed content so margin relationships stay readable. */
	borderPx?: number;
};

/** Channel 4: pixels. On demand, for visual judgement only. */
export async function pageImage(
	pdfPath: string,
	outDir: string,
	opts: PageImageOptions = {},
): Promise<PageImage> {
	const page = opts.page ?? 1;
	const dpi = opts.dpi ?? 150;
	const trim = opts.trim ?? true;
	const border = opts.borderPx ?? 10;
	const scale = dpi / 72;

	await mkdir(outDir, { recursive: true });
	// Keyed on the source PDF's own name, not just page/dpi. RenderEngine already names
	// each render `{contentHash}.pdf`; reusing that here is what makes this genuinely
	// content-addressed rather than "whichever render happened to write here last" —
	// without it, an agent's edit landed in a new PDF, but the raster this exact page/dpi
	// combination maps to had already been written for the *previous* render and never
	// changed name, so the client kept the old bitmap under a `src` that never varied.
	const pdfStem = basename(pdfPath).replace(/\.pdf$/i, "");
	const stem = `${outDir}/${pdfStem}-p${page}-${dpi}`;

	await run([
		"pdftoppm",
		"-png",
		"-r",
		String(dpi),
		"-f",
		String(page),
		"-l",
		String(page),
		"-singlefile",
		pdfPath,
		stem,
	]);
	const full = `${stem}.png`;

	const [fullW, fullH] = (
		await run(["magick", "identify", "-format", "%w %h", full])
	)
		.trim()
		.split(/\s+/)
		.map(Number) as [number, number];

	let src = full;
	let offsetX = 0;
	let offsetY = 0;
	let width = fullW;
	let height = fullH;

	if (opts.region) {
		const [rx, ry, rw, rh] = opts.region;
		const x = clamp(Math.floor(rx * scale), 0, fullW - 1);
		const y = clamp(Math.floor(ry * scale), 0, fullH - 1);
		const w = clamp(Math.ceil(rw * scale), 1, fullW - x);
		const h = clamp(Math.ceil(rh * scale), 1, fullH - y);
		const cropped = `${stem}-region.png`;
		await run([
			"magick",
			full,
			"-crop",
			`${w}x${h}+${x}+${y}`,
			"+repage",
			cropped,
		]);
		src = cropped;
		offsetX = x;
		offsetY = y;
		width = w;
		height = h;
	}

	if (trim) {
		// `identify -format %@` reports the trim bounding box without writing a file, so we
		// can expand it by the border ourselves and keep exact pre-trim offsets. Those
		// offsets are what let the agent map a pixel back to a page coordinate, and from
		// there back to a layout element.
		const bbox = (
			await run(["magick", "identify", "-format", "%@", src])
		).trim();
		const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(bbox);
		if (m) {
			const tw = Number(m[1]);
			const th = Number(m[2]);
			const tx = Number(m[3]);
			const ty = Number(m[4]);
			const x = clamp(tx - border, 0, width - 1);
			const y = clamp(ty - border, 0, height - 1);
			const w = clamp(tw + border * 2 + (tx - border - x), 1, width - x);
			const h = clamp(th + border * 2 + (ty - border - y), 1, height - y);
			const out = `${stem}-trim.png`;
			await run([
				"magick",
				src,
				"-crop",
				`${w}x${h}+${x}+${y}`,
				"+repage",
				out,
			]);
			src = out;
			offsetX += x;
			offsetY += y;
			width = w;
			height = h;
		}
		// A blank page yields no trim bbox; fall through and return the untrimmed raster.
	}

	return {
		path: src,
		widthPx: width,
		heightPx: height,
		dpi,
		offsetXPx: offsetX,
		offsetYPx: offsetY,
		pointsPerPixel: 72 / dpi,
		estimatedTokens: Math.round((width * height) / 750),
		trimmed: trim && src !== full,
	};
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}
