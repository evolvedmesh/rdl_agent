/**
 * Home — one card per report. The projection a consultant opens the app to see:
 * which reports exist, how many clients have a layout for each, and whether the last
 * render for each of them worked.
 */

import type { ReportCard } from "../api.ts";
import {
	Badge,
	Button,
	Card,
	Col,
	Row,
	Scroll,
	Text,
} from "../components/ui.tsx";
import { statusColor, statusLabel, t } from "../theme.ts";

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
	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<Row
				style={{
					paddingLeft: 20,
					paddingRight: 20,
					paddingTop: 16,
					paddingBottom: 14,
					borderBottomWidth: 1,
					borderColor: t.border,
				}}
			>
				<Col gap={3}>
					<Text size={18} weight={600}>
						Reports
					</Text>
					<Text color={t.textFaint} size={12}>
						{`${reports.length} report${reports.length === 1 ? "" : "s"}`}
					</Text>
				</Col>
				<div style={{ flexGrow: 1 }} />
				{/* duration_ms on every render row quietly answers the BC latency question
            over real use, so it is worth surfacing rather than only storing. */}
				{stats.p50Ms !== null ? (
					<Col gap={2} style={{ alignItems: "flex-end" }}>
						<Text color={t.textDim} size={11.5}>
							BC render latency
						</Text>
						<Text color={t.text} size={12.5} mono>
							{`p50 ${stats.p50Ms}ms · p95 ${stats.p95Ms}ms · n=${stats.okCount}`}
						</Text>
					</Col>
				) : null}
				<Button label="Add report" variant="primary" onClick={onAddReport} />
			</Row>

			<Scroll style={{ padding: 20 }}>
				{reports.length === 0 ? (
					<Col gap={10} style={{ padding: 24, maxWidth: 520 }}>
						<Text size={14}>Nothing set up yet</Text>
						<Text color={t.textDim} size={12}>
							Four things, in order — Settings covers the first two:
						</Text>
						<Col gap={5} style={{ paddingLeft: 4 }}>
							<Text color={t.textDim} size={12}>
								1. Shared credentials — the Entra app registration used for
								every tenant.
							</Text>
							<Text color={t.textDim} size={12}>
								2. A client, and a connection for it (tenant, environment,
								company).
							</Text>
							<Text color={t.textDim} size={12}>
								3. A report, by its Business Central object ID.
							</Text>
							<Text color={t.textDim} size={12}>
								4. A layout — the file that client uses for that report, with
								its preview parameters.
							</Text>
						</Col>
						<Row gap={8}>
							<Button
								label="Add report"
								variant="primary"
								onClick={onAddReport}
							/>
							<Button label="Add layout" onClick={onAddLayout} />
						</Row>
					</Col>
				) : (
					<div
						style={{
							display: "flex",
							flexDirection: "row",
							flexWrap: "wrap",
							gap: 14,
						}}
					>
						{reports.map((r) => (
							<Card
								key={r.id}
								onClick={() => onOpen(r.id)}
								style={{ width: 320 }}
							>
								<Row>
									<Text color={t.accent} size={13} mono weight={600}>
										{r.reportId}
									</Text>
									<div style={{ flexGrow: 1 }} />
									<Badge
										label={statusLabel(r.health)}
										color={statusColor(r.health)}
									/>
								</Row>
								<Text size={14} weight={500} clamp={2}>
									{r.name}
								</Text>
								<Row gap={14}>
									<Text color={t.textDim} size={12}>
										{`${r.clientCount} client${r.clientCount === 1 ? "" : "s"}`}
									</Text>
									<Text color={t.textDim} size={12}>
										{`${r.layoutCount} layout${r.layoutCount === 1 ? "" : "s"}`}
									</Text>
									{r.source ? (
										<Text color={t.textFaint} size={12} clamp={1}>
											{r.source}
										</Text>
									) : null}
								</Row>
							</Card>
						))}
					</div>
				)}
			</Scroll>
		</Col>
	);
}
