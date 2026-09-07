/**
 * Where to find the external CLIs the PDF ladder shells out to
 * (`pdfinfo`, `pdftotext`, `pdftoppm`, `magick`).
 *
 * In dev they come off `PATH`, same as always. A packaged single-file build has no
 * `node_modules` but still needs them, so resolution also looks, in order:
 *
 *   1. $LAYOUT_TOOLS_DIR                       explicit override
 *   2. <dir of the app binary>/ and /bin/     "drop the four binaries next to the app"
 *   3. PATH                                    the bare name, resolved by the OS
 *
 * The goal is that one binary plus (optionally) a `bin/` folder beside it is a fully
 * portable bundle, without giving up the normal "it's just on PATH" case.
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
	// process.execPath is the app binary in a compiled build, or `bun` in dev — either
	// way, a `bin/` sitting next to it is a deliberate bundle, worth checking.
	const selfDir = dirname(process.execPath);
	out.push(join(selfDir, file), join(selfDir, "bin", file));
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
		`pdfinfo/pdftotext/pdftoppm/magick in a "bin" folder next to the app ` +
		`(or point $LAYOUT_TOOLS_DIR at them).`
	);
}
