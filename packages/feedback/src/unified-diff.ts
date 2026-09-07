/**
 * A unified diff (git-patch text) between two strings.
 *
 * Exists for one reason: an agent's edit tool reports its change as an
 * `{ oldText, newText }` pair, and GPUIX's own `<diff>` element renders a `patch` string
 * — a real unified-diff format, with `@@` hunk headers and `+`/`-` lines — not raw before
 * and after text. Without this, the one thing a person actually wants to see after
 * asking an agent to change a layout ("what did it just do to my file") has nowhere to
 * go, which is exactly the gap this closes.
 *
 * The inputs here are edit-tool snippets — the changed region an agent's Edit call
 * reports, not typically a whole RDL file — so a classic O(N·M) LCS is fine. `maxLines`
 * is a defensive cap, not a tuned limit: if a provider ever hands over a whole file, this
 * degrades to "changed" rather than hanging on the diff.
 */

export type UnifiedDiffOptions = {
	path: string;
	contextLines?: number;
	/** Above this many lines total, skip the LCS and report a coarse change instead. */
	maxLines?: number;
};

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 4000;

/**
 * Longest common subsequence over lines, then a unified-diff patch from it.
 * Returns null when the inputs are identical — there is nothing to show.
 */
export function unifiedDiff(
	oldText: string,
	newText: string,
	opts: UnifiedDiffOptions,
): string | null {
	if (oldText === newText) return null;

	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const contextLines = opts.contextLines ?? DEFAULT_CONTEXT;
	const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

	if (oldLines.length + newLines.length > maxLines) {
		return coarsePatch(opts.path, oldLines.length, newLines.length);
	}

	const ops = diffOps(oldLines, newLines);
	const hunks = buildHunks(ops, contextLines);
	if (hunks.length === 0) return null;

	const header = `--- a/${opts.path}\n+++ b/${opts.path}\n`;
	return (
		header + hunks.map((h) => renderHunk(h, oldLines, newLines)).join("\n")
	);
}

function splitLines(s: string): string[] {
	// A trailing newline should not manufacture a phantom empty final line.
	const lines = s.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function coarsePatch(path: string, oldCount: number, newCount: number): string {
	return (
		`--- a/${path}\n+++ b/${path}\n` +
		`@@ Too large to diff line-by-line (${oldCount} → ${newCount} lines) @@\n` +
		`The content changed; see the file itself for the full text.\n`
	);
}

type Op = {
	kind: "same" | "del" | "add";
	oldIndex?: number;
	newIndex?: number;
};

/** Standard LCS-backtrack line diff. Fine for the small snippets tool calls report. */
function diffOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	// lcs[i][j] = length of the LCS of a[i:] and b[j:]
	const lcs: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		const row = lcs[i];
		const nextRow = lcs[i + 1];
		if (!row || !nextRow) continue;
		for (let j = m - 1; j >= 0; j--) {
			row[j] =
				a[i] === b[j]
					? (nextRow[j + 1] ?? 0) + 1
					: Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ kind: "same", oldIndex: i, newIndex: j });
			i++;
			j++;
		} else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
			ops.push({ kind: "del", oldIndex: i });
			i++;
		} else {
			ops.push({ kind: "add", newIndex: j });
			j++;
		}
	}
	while (i < n) ops.push({ kind: "del", oldIndex: i++ });
	while (j < m) ops.push({ kind: "add", newIndex: j++ });
	return ops;
}

type Hunk = { ops: Op[] };

/** Group changed lines with `contextLines` of unchanged lines around them, per hunk. */
function buildHunks(ops: Op[], contextLines: number): Hunk[] {
	const changedAt = ops
		.map((o, idx) => (o.kind === "same" ? -1 : idx))
		.filter((idx) => idx !== -1);
	if (changedAt.length === 0) return [];

	const ranges: [number, number][] = [];
	for (const idx of changedAt) {
		const start = Math.max(0, idx - contextLines);
		const end = Math.min(ops.length - 1, idx + contextLines);
		const last = ranges[ranges.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else ranges.push([start, end]);
	}
	return ranges.map(([start, end]) => ({ ops: ops.slice(start, end + 1) }));
}

function renderHunk(
	hunk: Hunk,
	oldLines: string[],
	newLines: string[],
): string {
	const oldNums = hunk.ops
		.map((o) => o.oldIndex)
		.filter((n): n is number => n !== undefined);
	const newNums = hunk.ops
		.map((o) => o.newIndex)
		.filter((n): n is number => n !== undefined);
	const oldStart = (oldNums[0] ?? 0) + 1;
	const newStart = (newNums[0] ?? 0) + 1;
	const header = `@@ -${oldStart},${oldNums.length} +${newStart},${newNums.length} @@\n`;

	const body = hunk.ops
		.map((o) => {
			if (o.kind === "same") return ` ${oldLines[o.oldIndex ?? 0]}`;
			if (o.kind === "del") return `-${oldLines[o.oldIndex ?? 0]}`;
			return `+${newLines[o.newIndex ?? 0]}`;
		})
		.join("\n");

	return `${header + body}\n`;
}
