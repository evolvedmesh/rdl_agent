/**
 * A unified-diff renderer.
 *
 * `call.diffPatch` is a real unified patch built from the edit's own before/after text
 * (see `unifiedDiff` in @layout/feedback). Without it an edit is a title and a
 * checkmark, which is what made "did it actually change the file" unanswerable from the
 * transcript alone.
 *
 * RDL lines run well past this pane, so the block scrolls horizontally rather than
 * wrapping — a wrapped XML line is unreadable, and a vertical scroller here would fight
 * the conversation's own.
 */

import { useMemo } from "react";
import { cx } from "./ui.tsx";

type Line = { kind: "add" | "del" | "ctx" | "meta"; text: string };

const MAX_LINES = 240;

function parse(patch: string): Line[] {
	const out: Line[] = [];
	for (const text of patch.split("\n")) {
		if (text.startsWith("+++") || text.startsWith("---")) continue;
		if (text.startsWith("@@")) out.push({ kind: "meta", text });
		else if (text.startsWith("+")) out.push({ kind: "add", text });
		else if (text.startsWith("-")) out.push({ kind: "del", text });
		else out.push({ kind: "ctx", text });
	}
	return out;
}

export function DiffBlock({ patch }: { patch: string }) {
	const lines = useMemo(() => parse(patch), [patch]);
	const shown = lines.slice(0, MAX_LINES);
	const added = lines.filter((l) => l.kind === "add").length;
	const removed = lines.filter((l) => l.kind === "del").length;

	return (
		<div className="overflow-hidden rounded-sm border border-subtle bg-canvas">
			<div className="flex items-center gap-2 border-b border-subtle px-2 py-1 text-2xs">
				<span className="text-ok">+{added}</span>
				<span className="text-danger">−{removed}</span>
			</div>
			<div className="max-h-64 overflow-auto">
				<pre className="w-max min-w-full font-mono text-[11px] leading-normal">
					{shown.map((l, i) => (
						<div
							key={`${i}-${l.text}`}
							className={cx(
								"px-2",
								l.kind === "add" && "bg-ok-soft text-ok",
								l.kind === "del" && "bg-danger-soft text-danger",
								l.kind === "meta" && "bg-raised text-faint",
								l.kind === "ctx" && "text-dim",
							)}
						>
							{l.text || " "}
						</div>
					))}
				</pre>
			</div>
			{lines.length > MAX_LINES ? (
				<div className="border-t border-subtle px-2 py-1 text-2xs text-faint">
					{lines.length - MAX_LINES} more lines not shown
				</div>
			) : null}
		</div>
	);
}

/** A plain preformatted block for tool output that is not a diff. */
export function CodeBlock({
	code,
	maxHeight = 160,
}: {
	code: string;
	maxHeight?: number;
}) {
	return (
		<div
			style={{ maxHeight }}
			className="overflow-auto rounded-sm border border-subtle bg-canvas"
		>
			<pre className="w-max min-w-full px-2 py-1.5 font-mono text-[11px] leading-normal text-dim">
				{code}
			</pre>
		</div>
	);
}
