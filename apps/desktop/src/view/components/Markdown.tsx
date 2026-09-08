/**
 * Agent prose, rendered as markdown.
 *
 * The text comes from a language model and can contain anything, and this document has
 * a same-origin credential for a server that spawns processes and reads credentials.
 * So it is sanitised on the way in — `marked` alone is not a security boundary.
 */

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { cx } from "./ui.tsx";

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({
	source,
	className,
}: {
	source: string;
	className?: string;
}) {
	const html = useMemo(() => {
		const raw = marked.parse(source, { async: false });
		return DOMPurify.sanitize(raw, {
			// No <img>: a remote src would leak the fact this window is open, and there is
			// nothing an agent needs to render that way.
			FORBID_TAGS: ["img", "style", "form", "input", "iframe", "object"],
			FORBID_ATTR: ["style", "srcset", "formaction"],
		});
	}, [source]);

	return (
		<div
			dangerouslySetInnerHTML={{ __html: html }}
			className={cx(
				"prose-agent text-base leading-[1.55] wrap-break-word",
				className,
			)}
		/>
	);
}
