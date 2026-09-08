/**
 * Where to find the external CLIs the PDF ladder shells out to
 * (`pdfinfo`, `pdftotext`, `pdftoppm`, `magick`).
 *
 * In dev they come off `PATH`, same as always. A packaged build has no `node_modules`
 * but still needs them, so resolution also looks, in order:
 *
 *   1. $LAYOUT_TOOLS_DIR                    explicit override
 *   2. <dir of the running binary>/         and its `tools/` and `../tools/`
 *   3. PATH                                 the bare name, resolved by the OS
 *
 * `tools/`, not `bin/`: inside an Electrobun bundle the running binary lives in
 * `<app>/bin/` alongside Electrobun's own `launcher`, `bspatch` and `zig-zstd`, so
 * dropping poppler in there would mix our payload into theirs.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";
const cache = new Map<string, string>();

function candidates(name: string): string[] {
	const file = `${name}${EXE}`;
	const out: string[] = [];
	const envDir = process.env.LAYOUT_TOOLS_DIR;
	if (envDir) out.push(join(envDir, file));
	// process.execPath is the app binary in a compiled build, the bundled `bun` under
	// Electrobun, or `bun` in dev — either way a sibling `tools/` is a deliberate bundle.
	const selfDir = dirname(process.execPath);
	out.push(
		join(selfDir, file),
		join(selfDir, "tools", file),
		join(selfDir, "..", "tools", file),
	);
	return out;
}

/**
 * Absolute path to a bundled copy of `name` if one exists, otherwise `name` unchanged so
 * `Bun.spawn` resolves it against PATH.
 */
export function resolveTool(name: string): string {
	const hit = cache.get(name);
	if (hit) return hit;
	const found = candidates(name).find((p) => existsSync(p)) ?? name;
	cache.set(name, found);
	return found;
}

/** For a clearer error than a bare ENOENT when a tool is genuinely missing. */
export function missingToolMessage(name: string): string {
	return (
		`"${name}" was not found. Install poppler-utils and ImageMagick, or put ` +
		`pdfinfo/pdftotext/pdftoppm/magick in a "tools" folder next to the app ` +
		`(or point $LAYOUT_TOOLS_DIR at them).`
	);
}
