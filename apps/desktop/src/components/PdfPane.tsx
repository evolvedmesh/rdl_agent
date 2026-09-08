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
import { font, radius, shadow, t } from "../theme.ts";
import { Col, IconButton, Row, Spacer, Text } from "./ui.tsx";

const ZOOMS = [50, 75, 100, 125, 150, 200, 300] as const;
const DEFAULT_ZOOM_INDEX = 2;

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
	const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
	const [page, setPage] = useState(1);
	const [loading, setLoading] = useState(false);
	const [raster, setRaster] = useState<{
		path: string;
		widthPx: number;
		heightPx: number;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);

	const zoom = ZOOMS[zoomIndex] ?? 100;
	const dpi = Math.round((72 * zoom) / 100);

	useEffect(() => {
		let cancelled = false;
		if (!layoutId) {
			setRaster(null);
			return;
		}
		setLoading(true);
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
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [api, layoutId, page, dpi, version]);

	useEffect(() => {
		if (page > pageCount && pageCount > 0) setPage(1);
	}, [pageCount, page]);

	return (
		<Col
			gap={0}
			grow={1}
			style={{ minWidth: 0, minHeight: 0, backgroundColor: t.bg }}
		>
			<Row
				gap={8}
				style={{
					paddingLeft: 12,
					paddingRight: 10,
					paddingTop: 7,
					paddingBottom: 7,
					borderBottomWidth: 1,
					borderColor: t.border,
					backgroundColor: t.bgPanel,
					flexShrink: 0,
				}}
			>
				<Text color={t.textDim} size={font.sm} weight={500} clamp={1}>
					{title ?? "Preview"}
				</Text>
				{loading ? (
					<Text color={t.accent} size={font.xs}>
						loading…
					</Text>
				) : null}
				<Spacer />

				{pageCount > 1 ? (
					<Row
						gap={2}
						style={{
							paddingLeft: 2,
							paddingRight: 2,
							borderRadius: radius.sm,
							borderWidth: 1,
							borderColor: t.border,
							backgroundColor: t.bgSunken,
						}}
					>
						<IconButton
							glyph="‹"
							title="previous page"
							size={22}
							disabled={page <= 1}
							onClick={() => setPage((p) => Math.max(1, p - 1))}
						/>
						<Text color={t.textDim} size={font.xs} mono>
							{`${page} / ${pageCount}`}
						</Text>
						<IconButton
							glyph="›"
							title="next page"
							size={22}
							disabled={page >= pageCount}
							onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
						/>
					</Row>
				) : null}

				<Row
					gap={2}
					style={{
						paddingLeft: 2,
						paddingRight: 2,
						borderRadius: radius.sm,
						borderWidth: 1,
						borderColor: t.border,
						backgroundColor: t.bgSunken,
					}}
				>
					<IconButton
						glyph="−"
						title="zoom out"
						size={22}
						disabled={zoomIndex === 0}
						onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
					/>
					<div
						onClick={() => setZoomIndex(DEFAULT_ZOOM_INDEX)}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							width: 40,
							cursor: "pointer",
						}}
					>
						<text
							style={{
								color: t.textDim,
								fontSize: font.xs,
								fontFamily: t.mono,
							}}
						>
							{`${zoom}%`}
						</text>
					</div>
					<IconButton
						glyph="+"
						title="zoom in"
						size={22}
						disabled={zoomIndex === ZOOMS.length - 1}
						onClick={() =>
							setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))
						}
					/>
				</Row>
			</Row>

			{/* One scroller for this pane. Its sibling (the chat, or the layout list) has its
          own; nesting them would let the inner one swallow the wheel. */}
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
					padding: 18,
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
							borderRadius: radius.xs,
							borderWidth: 1,
							borderColor: "#00000066",
							backgroundColor: "#ffffff",
							boxShadow: shadow.md,
						}}
					/>
				) : (
					<Col
						gap={8}
						style={{
							flexGrow: 1,
							alignSelf: "stretch",
							alignItems: "center",
							justifyContent: "center",
							padding: 40,
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								width: 46,
								height: 58,
								marginBottom: 4,
								borderRadius: radius.xs,
								borderWidth: 1,
								borderColor: t.borderStrong,
								backgroundColor: t.bgPanel,
							}}
						>
							<text style={{ color: t.textFaint, fontSize: 18 }}>◫</text>
						</div>
						<Text color={t.textDim} size={font.md} weight={500}>
							{error ? "Could not load the page" : "No render yet"}
						</Text>
						<Text
							color={t.textFaint}
							size={font.base}
							align="center"
							style={{ maxWidth: 360 }}
						>
							{error ?? "Render this layout to see the page here."}
						</Text>
					</Col>
				)}
			</div>
		</Col>
	);
}
