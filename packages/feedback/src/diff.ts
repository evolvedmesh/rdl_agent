/**
 * Channel 3: geometry diff.
 *
 * `pdftotext -bbox-layout` is 25,900 characters on the sample. It is never sent to a
 * model. It is parsed, diffed against the previous render here in code, and only the
 * deltas go out — roughly 100 tokens. This is what turns "try something and look at it"
 * into "verify the change did exactly what was intended".
 */
import type { Geometry, Page, Word } from "./pdf.ts";

const MOVE_EPS = 0.5; // points; below this is renderer rounding
const LINE_BAND = 2.0; // points; words within this yMin band are on the same line

type Line = { y: number; words: Word[]; text: string };

function lines(page: Page): Line[] {
	const sorted = [...page.words].sort(
		(a, b) => a.yMin - b.yMin || a.xMin - b.xMin,
	);
	const out: Line[] = [];
	for (const w of sorted) {
		const last = out[out.length - 1];
		if (last && Math.abs(w.yMin - last.y) <= LINE_BAND) {
			last.words.push(w);
		} else {
			out.push({ y: w.yMin, words: [w], text: "" });
		}
	}
	for (const l of out) {
		l.words.sort((a, b) => a.xMin - b.xMin);
		l.text = l.words.map((w) => w.text).join(" ");
	}
	return out;
}

function contentBox(page: Page) {
	if (page.words.length === 0) return undefined;
	return {
		xMin: Math.min(...page.words.map((w) => w.xMin)),
		yMin: Math.min(...page.words.map((w) => w.yMin)),
		xMax: Math.max(...page.words.map((w) => w.xMax)),
		yMax: Math.max(...page.words.map((w) => w.yMax)),
	};
}

/**
 * Match words between two renders by (text, nth occurrence).
 *
 * Layout work overwhelmingly moves text without changing it, so occurrence order is a
 * reliable and O(n) key. Words whose occurrence counts differ between renders are not
 * matched at all — they surface as added/removed instead, which is the honest answer.
 */
function matchWords(
	before: Word[],
	after: Word[],
): { pairs: [Word, Word][]; added: Word[]; removed: Word[] } {
	const index = (ws: Word[]) => {
		const m = new Map<string, Word[]>();
		for (const w of ws) {
			const list = m.get(w.text);
			if (list) list.push(w);
			else m.set(w.text, [w]);
		}
		return m;
	};
	const bi = index(before);
	const ai = index(after);

	const pairs: [Word, Word][] = [];
	const added: Word[] = [];
	const removed: Word[] = [];

	for (const [text, bws] of bi) {
		const aws = ai.get(text) ?? [];
		const n = Math.min(bws.length, aws.length);
		for (let k = 0; k < n; k++) {
			const bw = bws[k];
			const aw = aws[k];
			if (bw && aw) pairs.push([bw, aw]);
		}
		removed.push(...bws.slice(n));
	}
	for (const [text, aws] of ai) {
		const bws = bi.get(text) ?? [];
		if (aws.length > bws.length) added.push(...aws.slice(bws.length));
	}

	return { pairs, added, removed };
}

export type DiffOptions = {
	/** Cap the emitted report so a diff can never become the expensive channel. */
	maxGroups?: number;
	maxExamples?: number;
};

export function diffGeometry(
	before: Geometry,
	after: Geometry,
	opts: DiffOptions = {},
): string {
	const maxGroups = opts.maxGroups ?? 6;
	const maxExamples = opts.maxExamples ?? 8;
	const out: string[] = [];

	if (before.pages.length !== after.pages.length) {
		out.push(
			`Page count ${before.pages.length} → ${after.pages.length}. ` +
				`Positions below compare pages by index, so an inserted page will make every ` +
				`later page look wholly changed.`,
		);
	}

	const pageCount = Math.min(before.pages.length, after.pages.length);
	let anyChange = before.pages.length !== after.pages.length;

	for (let p = 0; p < pageCount; p++) {
		const bp = before.pages[p];
		const ap = after.pages[p];
		if (!bp || !ap) continue;
		const notes: string[] = [];

		const bb = contentBox(bp);
		const ab = contentBox(ap);
		if (bb && ab) {
			const deltas: string[] = [];
			for (const k of ["xMin", "yMin", "xMax", "yMax"] as const) {
				const d = ab[k] - bb[k];
				if (Math.abs(d) > MOVE_EPS) {
					deltas.push(
						`${k} ${bb[k].toFixed(1)} → ${ab[k].toFixed(1)} (${sign(d)}pt)`,
					);
				}
			}
			if (deltas.length) notes.push(`Content box: ${deltas.join(", ")}.`);
		} else if (bb && !ab) {
			notes.push("Page is now blank.");
		} else if (!bb && ab) {
			notes.push("Page was blank and now has content.");
		}

		const { pairs, added, removed } = matchWords(bp.words, ap.words);

		// Cluster moves by rounded delta: "31 words shifted (−12.3, 0.0)" is one useful
		// line where 31 individual reports would be noise.
		const groups = new Map<string, { dx: number; dy: number; words: Word[] }>();
		for (const [b, a] of pairs) {
			const dx = a.xMin - b.xMin;
			const dy = a.yMin - b.yMin;
			if (Math.abs(dx) <= MOVE_EPS && Math.abs(dy) <= MOVE_EPS) continue;
			const key = `${dx.toFixed(1)}|${dy.toFixed(1)}`;
			const g = groups.get(key);
			if (g) g.words.push(a);
			else groups.set(key, { dx, dy, words: [a] });
		}

		const ranked = [...groups.values()].sort(
			(x, y) => y.words.length - x.words.length,
		);
		for (const g of ranked.slice(0, maxGroups)) {
			const sample = g.words
				.slice(0, 3)
				.map((w) => `"${w.text}"`)
				.join(", ");
			notes.push(
				`${g.words.length} word(s) moved by (${sign(g.dx)}, ${sign(g.dy)})pt — e.g. ${sample}.`,
			);
		}
		if (ranked.length > maxGroups) {
			const rest = ranked
				.slice(maxGroups)
				.reduce((n, g) => n + g.words.length, 0);
			notes.push(
				`…and ${rest} further word(s) in ${ranked.length - maxGroups} smaller move groups.`,
			);
		}

		// Width changes are the ones that actually cause wrapping, so call them out.
		const widthChanges = pairs
			.map(([b, a]) => ({
				text: a.text,
				d: a.xMax - a.xMin - (b.xMax - b.xMin),
			}))
			.filter((c) => Math.abs(c.d) > MOVE_EPS);
		const [worst] = widthChanges.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
		if (worst) {
			notes.push(
				`${widthChanges.length} word(s) changed rendered width (font or scaling changed); ` +
					`largest "${worst.text}" ${sign(worst.d)}pt.`,
			);
		}

		const wraps = detectWraps(bp, ap, pairs);
		for (const w of wraps.slice(0, maxExamples)) notes.push(w);

		if (removed.length) {
			notes.push(
				`${removed.length} word(s) gone: ${preview(removed, maxExamples)}.`,
			);
		}
		if (added.length) {
			notes.push(
				`${added.length} word(s) new: ${preview(added, maxExamples)}.`,
			);
		}

		if (notes.length) {
			anyChange = true;
			out.push(`Page ${p + 1}:`, ...notes.map((n) => `  ${n}`));
		}
	}

	if (!anyChange)
		return "No geometry change: every word is within 0.5pt of its previous position.";
	return out.join("\n");
}

/**
 * The wrap check the loop actually cares about: a line of text that used to sit on one
 * baseline whose words are now spread across several.
 */
function detectWraps(
	before: Page,
	after: Page,
	pairs: [Word, Word][],
): string[] {
	const moved = new Map<Word, Word>(pairs);
	const notes: string[] = [];

	for (const line of lines(before)) {
		const partners = line.words
			.map((w) => moved.get(w))
			.filter((w): w is Word => w !== undefined);
		if (partners.length < 2) continue;
		const bands = new Set(partners.map((w) => Math.round(w.yMin / LINE_BAND)));
		if (bands.size > 1) {
			notes.push(
				`Line "${truncate(line.text, 60)}" now spans ${bands.size} lines (it wrapped).`,
			);
		}
	}

	const reverse = new Map<Word, Word>(pairs.map(([b, a]) => [a, b]));
	for (const line of lines(after)) {
		const partners = line.words
			.map((w) => reverse.get(w))
			.filter((w): w is Word => w !== undefined);
		if (partners.length < 2) continue;
		const bands = new Set(partners.map((w) => Math.round(w.yMin / LINE_BAND)));
		if (bands.size > 1) {
			notes.push(
				`Line "${truncate(line.text, 60)}" was wrapped across ${bands.size} lines and now fits on one.`,
			);
		}
	}

	return notes;
}

const sign = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`;
const truncate = (s: string, n: number) =>
	s.length <= n ? s : `${s.slice(0, n - 1)}…`;
const preview = (ws: Word[], n: number) => {
	const shown = ws
		.slice(0, n)
		.map((w) => `"${w.text}"`)
		.join(", ");
	return ws.length > n ? `${shown}, +${ws.length - n} more` : shown;
};
