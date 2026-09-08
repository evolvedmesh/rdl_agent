/**
 * The rendered page.
 *
 * A page is an <img> of a raster the server produced, which turns out to be an advantage
 * for zoom: rather than scaling an existing bitmap, we re-request the page at the target
 * DPI, so zooming *increases* real resolution instead of enlarging pixels.
 */

import { useEffect, useRef, useState } from "react";
import type { Api } from "../api.ts";
import { Button, cx, IconButton, Spinner } from "./ui.tsx";

const ZOOMS = [50, 75, 100, 125, 150, 200, 300] as const;
const DEFAULT_ZOOM_INDEX = 2;

export function PdfPane({
	api,
	layoutId,
	pageCount,
	version,
	title,
	className,
}: {
	api: Api;
	layoutId: string | null;
	pageCount: number;
	/** Bump to force a re-fetch after a new render. */
	version: number;
	title?: string;
	className?: string;
}) {
	const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
	const [page, setPage] = useState(1);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const scroller = useRef<HTMLDivElement>(null);

	const zoom = ZOOMS[zoomIndex] ?? 100;
	const dpi = Math.round((72 * zoom) / 100);

	useEffect(() => {
		if (page > pageCount && pageCount > 0) setPage(1);
	}, [pageCount, page]);

	useEffect(() => {
		setError(null);
		setLoading(Boolean(layoutId));
	}, [layoutId, page, dpi, version]);

	// A new page should start at the top, not wherever the last one was scrolled to.
	useEffect(() => {
		scroller.current?.scrollTo({ top: 0 });
	}, [page]);

	const src = layoutId
		? `${api.pageUrl(layoutId, page, dpi)}&v=${version}`
		: null;

	return (
		<div className={cx("flex min-h-0 min-w-0 flex-col bg-canvas", className)}>
			<div className="flex shrink-0 items-center gap-2 border-b border-subtle bg-panel py-1.5 pr-2.5 pl-3">
				<span className="truncate text-sm font-medium text-dim">
					{title ?? "Preview"}
				</span>
				{loading ? <Spinner className="text-accent" /> : null}
				<span className="flex-1" />

				{pageCount > 1 ? (
					<div className="flex items-center gap-0.5 rounded-sm border border-subtle bg-sunken px-0.5">
						<IconButton
							label="previous page"
							disabled={page <= 1}
							onClick={() => setPage((p) => Math.max(1, p - 1))}
						>
							‹
						</IconButton>
						<span className="min-w-14 text-center font-mono text-xs text-dim tabular-nums">
							{page} / {pageCount}
						</span>
						<IconButton
							label="next page"
							disabled={page >= pageCount}
							onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
						>
							›
						</IconButton>
					</div>
				) : null}

				<div className="flex items-center gap-0.5 rounded-sm border border-subtle bg-sunken px-0.5">
					<IconButton
						label="zoom out"
						disabled={zoomIndex <= 0}
						onClick={() => setZoomIndex((z) => Math.max(0, z - 1))}
					>
						−
					</IconButton>
					<span className="min-w-11 text-center font-mono text-xs text-dim tabular-nums">
						{zoom}%
					</span>
					<IconButton
						label="zoom in"
						disabled={zoomIndex >= ZOOMS.length - 1}
						onClick={() =>
							setZoomIndex((z) => Math.min(ZOOMS.length - 1, z + 1))
						}
					>
						+
					</IconButton>
				</div>
			</div>

			<div
				ref={scroller}
				className="min-h-0 flex-1 overflow-auto p-4"
				// Not centred: a page wider than its scroller would clip at the leading
				// edge and become unreachable.
			>
				{!layoutId ? (
					<Placeholder text="Select a layout to preview its last render." />
				) : error ? (
					<Placeholder text={error} tone="danger" />
				) : src ? (
					<img
						key={src}
						src={src}
						alt={`Page ${page}`}
						onLoad={() => setLoading(false)}
						onError={() => {
							setLoading(false);
							setError("No render yet for this layout.");
						}}
						className={cx(
							"mx-auto block h-auto max-w-none rounded-sm bg-white shadow-float",
							"transition-opacity duration-200",
							loading ? "opacity-40" : "opacity-100",
						)}
					/>
				) : null}
			</div>
		</div>
	);
}

function Placeholder({ text, tone }: { text: string; tone?: "danger" }) {
	return (
		<div className="flex h-full items-center justify-center px-6 text-center">
			<p
				className={cx(
					"max-w-sm text-sm",
					tone === "danger" ? "text-danger" : "text-faint",
				)}
			>
				{text}
			</p>
		</div>
	);
}

export { Button };
