/**
 * Home — one card per report. The projection a consultant opens the app to see:
 * which reports exist, how many clients have a layout for each, and whether the last
 * render for each of them worked.
 *
 * The grid is measured rather than `flexGrow`-ed. Letting cards grow to fill their row
 * makes the last row's two cards twice the width of the four above them; computing a
 * column count from the window width instead keeps every card the same size, which is
 * the whole point of a card grid.
 */

import type { ReportCard } from "../api.ts";
import {
	Badge,
	Button,
	Card,
	Col,
	gutter,
	Measure,
	PageHeader,
	Row,
	Scroll,
	Spacer,
	Stat,
	Text,
	useBreakpoint,
} from "../components/ui.tsx";
import { font, radius, statusLabel, statusTone, t } from "../theme.ts";

const CARD_MIN = 292;
const CARD_GAP = 14;

export function Reports({
	reports,
	stats,
	onOpen,
	onAddReport,
	onAddLayout,
}: {
	reports: ReportCard[];
	stats: {
		count: number;
		okCount: number;
		p50Ms: number | null;
		p95Ms: number | null;
	};
	onOpen: (reportId: string) => void;
	onAddReport: () => void;
	onAddLayout: () => void;
}) {
	const b = useBreakpoint();
	const pad = gutter(b);

	// Everything the grid does not get: the docked sidebar, both gutters, and room for
	// the scrollbar the list will grow into.
	const content = Math.max(
		CARD_MIN,
		b.width - (b.narrow ? 0 : 244) - pad * 2 - 14,
	);
	const cols = Math.max(1, Math.min(4, Math.floor(content / CARD_MIN)));
	const cardWidth = Math.floor((content - CARD_GAP * (cols - 1)) / cols);

	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<PageHeader
				title="Reports"
				subtitle={`${reports.length} report${reports.length === 1 ? "" : "s"} · ${stats.count} render${stats.count === 1 ? "" : "s"} recorded`}
				compact={b.compact}
				actions={
					<>
						{/* duration_ms on every render row quietly answers the BC latency
                question over real use, so it is worth surfacing rather than only
                storing. */}
						{stats.p50Ms !== null && !b.narrow ? (
							<>
								<Stat label="p50" value={`${stats.p50Ms}ms`} mono />
								<Stat label="p95" value={`${stats.p95Ms}ms`} mono />
								<div
									style={{
										width: 1,
										height: 26,
										backgroundColor: t.border,
										marginLeft: 4,
										marginRight: 4,
									}}
								/>
							</>
						) : null}
						<Button label="Add layout" variant="subtle" onClick={onAddLayout} />
						<Button
							label="Add report"
							icon="+"
							variant="primary"
							onClick={onAddReport}
						/>
					</>
				}
			/>

			<Scroll style={{ padding: pad }}>
				{reports.length === 0 ? (
					<Onboarding onAddReport={onAddReport} onAddLayout={onAddLayout} />
				) : (
					<div
						style={{
							display: "flex",
							flexDirection: "row",
							flexWrap: "wrap",
							gap: CARD_GAP,
						}}
					>
						{reports.map((r) => (
							<Card
								key={r.id}
								onClick={() => onOpen(r.id)}
								style={{ width: cardWidth }}
							>
								<Row gap={8}>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											paddingLeft: 7,
											paddingRight: 7,
											paddingTop: 2,
											paddingBottom: 2,
											borderRadius: radius.xs,
											backgroundColor: t.accentSoft,
											borderWidth: 1,
											borderColor: "#2d4478",
											flexShrink: 0,
										}}
									>
										<text
											style={{
												color: t.accentHi,
												fontSize: font.sm,
												fontFamily: t.mono,
												fontWeight: 600,
											}}
										>
											{String(r.reportId)}
										</text>
									</div>
									<Spacer />
									<Badge
										label={statusLabel(r.health)}
										tone={statusTone(r.health)}
										dot
									/>
								</Row>

								<Text size={font.md} weight={500} clamp={2}>
									{r.name}
								</Text>

								{r.source ? (
									<Text color={t.textFaint} size={font.xs} mono clamp={1}>
										{r.source}
									</Text>
								) : null}

								<div
									style={{
										height: 1,
										backgroundColor: t.border,
										marginTop: 2,
									}}
								/>

								<Row gap={14}>
									<Text color={t.textDim} size={font.sm}>
										{`${r.clientCount} client${r.clientCount === 1 ? "" : "s"}`}
									</Text>
									<Text color={t.textDim} size={font.sm}>
										{`${r.layoutCount} layout${r.layoutCount === 1 ? "" : "s"}`}
									</Text>
									<Spacer />
									<Text color={t.textFaint} size={font.sm}>
										Open ›
									</Text>
								</Row>
							</Card>
						))}
					</div>
				)}
			</Scroll>
		</Col>
	);
}

function Onboarding({
	onAddReport,
	onAddLayout,
}: {
	onAddReport: () => void;
	onAddLayout: () => void;
}) {
	const steps = [
		"Shared credentials — the Entra app registration used for every tenant.",
		"A client, and a connection for it (tenant, environment, company).",
		"A report, by its Business Central object ID.",
		"A layout — the file that client uses for that report, with its preview parameters.",
	];
	return (
		<Measure max={620} gap={0} style={{ paddingTop: 24 }}>
			<Card padding={22} gap={14}>
				<Col gap={5}>
					<Text size={font.lg} weight={600}>
						Nothing set up yet
					</Text>
					<Text color={t.textDim} size={font.base}>
						Four things, in order — Settings covers the first two.
					</Text>
				</Col>

				<Col gap={9}>
					{steps.map((s, i) => (
						<Row key={s} gap={10} align="flex-start">
							<div
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									width: 20,
									height: 20,
									flexShrink: 0,
									borderRadius: radius.pill,
									backgroundColor: t.bgRaised,
									borderWidth: 1,
									borderColor: t.borderStrong,
								}}
							>
								<text style={{ color: t.textDim, fontSize: font.xs }}>
									{String(i + 1)}
								</text>
							</div>
							{/* A <text> is a flex child like any other: without a column of its own
                  that may shrink to zero, it takes its content's intrinsic width and
                  paints straight past the card's edge. */}
							<Col style={{ flexGrow: 1, minWidth: 0 }}>
								<Text color={t.textDim} size={font.base} lineHeight={19}>
									{s}
								</Text>
							</Col>
						</Row>
					))}
				</Col>

				<Row gap={8} style={{ paddingTop: 4 }}>
					<Button
						label="Add report"
						icon="+"
						variant="primary"
						onClick={onAddReport}
					/>
					<Button label="Add layout" variant="subtle" onClick={onAddLayout} />
				</Row>
			</Card>
		</Measure>
	);
}
