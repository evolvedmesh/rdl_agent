/**
 * The rendered page.
 *
 * There is no webview here, so a page is an <img> of a raster the server produced. That
 * turns out to be an advantage for zoom: rather than scaling an existing bitmap, we
 * re-request the page at the target DPI, so zooming *increases* real resolution instead
 * of enlarging pixels.
 *
 * The rule the GPUIX README is emphatic about: always set both `width` and `height` on
 * an image, or the box is empty until decode and then jumps to the bitmap's size.
 */
import { useEffect, useState } from "react";
import type { Api } from "../api.ts";
import { t } from "../theme.ts";
import { Button, Col, Row, Text } from "./ui.tsx";

const ZOOMS = [75, 100, 150, 200] as const;

export function PdfPane({
	api,
	layoutId,
	pageCount,
	version,
	title,
}: {
	api: Api;
	layoutId: string | null;
	pageCount: number;
	/** Bump to force a re-fetch after a new render. */
	version: number;
	title?: string;
}) {
	const [zoom, setZoom] = useState<number>(100);
	const [page, setPage] = useState(1);
	const [raster, setRaster] = useState<{
		path: string;
		widthPx: number;
		heightPx: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);

	const dpi = Math.round((72 * zoom) / 100);

	useEffect(() => {
		let cancelled = false;
		if (!layoutId) {
			setRaster(null);
			return;
		}
		void api
			.pageRaster(layoutId, page, dpi)
			.then((r) => {
				if (!cancelled) {
					setRaster(r);
					setError(null);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setRaster(null);
					setError(e instanceof Error ? e.message : String(e));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [api, layoutId, page, dpi, version]);

	useEffect(() => {
		if (page > pageCount && pageCount > 0) setPage(1);
	}, [pageCount, page]);

	return (
		<Col gap={0} grow={1} style={{ minWidth: 0, backgroundColor: t.bg }}>
			<Row
				gap={8}
				style={{
					paddingLeft: 12,
					paddingRight: 12,
					paddingTop: 8,
					paddingBottom: 8,
					borderBottomWidth: 1,
					borderColor: t.border,
					backgroundColor: t.bgPanel,
				}}
			>
				<Text color={t.textDim} size={12}>
					{title ?? "Preview"}
				</Text>
				<div style={{ flexGrow: 1 }} />
				{pageCount > 1 ? (
					<Row gap={4}>
						<Button
							label="‹"
							variant="ghost"
							onClick={() => setPage((p) => Math.max(1, p - 1))}
						/>
						<Text color={t.textDim} size={12}>
							{`${page} / ${pageCount}`}
						</Text>
						<Button
							label="›"
							variant="ghost"
							onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
						/>
					</Row>
				) : null}
				<Row gap={4}>
					{ZOOMS.map((z) => (
						<div
							key={z}
							onClick={() => setZoom(z)}
							style={{
								display: "flex",
								paddingLeft: 7,
								paddingRight: 7,
								paddingTop: 3,
								paddingBottom: 3,
								borderRadius: 4,
								backgroundColor: z === zoom ? t.bgActive : "transparent",
								cursor: "pointer",
								hover: { backgroundColor: t.bgHover },
							}}
						>
							<text
								style={{
									color: z === zoom ? t.text : t.textFaint,
									fontSize: 11,
								}}
							>{`${z}%`}</text>
						</div>
					))}
				</Row>
			</Row>

			{/* One scroller for this pane. Its sibling (the chat) has its own; nesting them
          would let the inner one swallow the wheel. */}
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					// Not "center": an image wider than the pane would have its left edge clipped
					// and unreachable, because the overflow goes both ways from the centre.
					alignItems: "flex-start",
					overflowY: "scroll",
					overflowX: "scroll",
					flexGrow: 1,
					minHeight: 0,
					padding: 16,
				}}
			>
				{raster && layoutId ? (
					// src is a filesystem path: GPUI's image loader reads files, not URLs.
					// Width and height come from the raster itself, and both must be set or the
					// box is empty until decode and then jumps to the bitmap's size.
					<img
						src={raster.path}
						objectFit="contain"
						style={{
							width: raster.widthPx,
							height: raster.heightPx,
							borderRadius: 2,
							borderWidth: 1,
							borderColor: t.border,
							backgroundColor: "#ffffff",
						}}
					/>
				) : (
					<Col gap={6} style={{ padding: 40, alignItems: "center" }}>
						<Text color={t.textDim}>
							{error ? "Could not load the page" : "No render yet"}
						</Text>
						<Text color={t.textFaint} size={12}>
							{error ?? "Render this layout to see the page here."}
						</Text>
					</Col>
				)}
			</div>
		</Col>
	);
}
