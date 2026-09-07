/**
 * The clients × layouts table.
 *
 * The same rows serve the report page and the client page — one is the other pivoted,
 * which is why this is one component and one query rather than two of each. A consultant
 * onboarding a client thinks in the client direction; someone fixing a report thinks in
 * the report direction.
 */
import { connectionLabel, type LayoutDetail } from "@layout/core";
import {
	Badge,
	Button,
	Col,
	Empty,
	Row,
	Scroll,
	Text,
} from "../components/ui.tsx";
import { statusColor, t } from "../theme.ts";

export type LayoutTableMode = "by-client" | "by-report";

function health(l: LayoutDetail): { label: string; color: string } {
	if (!l.lastRender) return { label: "never rendered", color: t.textFaint };
	if (!l.lastRender.ok) return { label: "render failed", color: t.danger };
	const age = Date.now() - new Date(l.lastRender.createdAt).getTime();
	const mins = Math.round(age / 60000);
	const when =
		mins < 1
			? "just now"
			: mins < 60
				? `${mins}m ago`
				: `${Math.round(mins / 60)}h ago`;
	return { label: `ok ${when}`, color: t.ok };
}

export function LayoutTable({
	layouts,
	mode,
	busyIds,
	onRender,
	onSession,
	onDuplicate,
	onEditParams,
	onDelete,
	onSelect,
	selectedId,
}: {
	layouts: LayoutDetail[];
	mode: LayoutTableMode;
	busyIds: Set<string>;
	onRender: (layoutId: string) => void;
	onSession: (layoutId: string) => void;
	onDuplicate: (layout: LayoutDetail) => void;
	onEditParams: (layout: LayoutDetail) => void;
	onDelete: (layout: LayoutDetail) => void;
	onSelect: (layoutId: string) => void;
	selectedId: string | null;
}) {
	if (layouts.length === 0) {
		return (
			<Empty
				title="No layouts here yet"
				hint="Duplicate another client's layout to get started."
			/>
		);
	}

	return (
		<Scroll>
			<Col gap={0}>
				{layouts.map((l) => {
					const h = health(l);
					const selected = l.id === selectedId;
					const busy = busyIds.has(l.id);
					return (
						<div
							key={l.id}
							onClick={() => onSelect(l.id)}
							style={{
								display: "flex",
								flexDirection: "row",
								alignItems: "center",
								// The actions wrap under the text on a narrow pane rather than being
								// pushed out of reach: this pane is about 520px when a layout is
								// selected, which is not enough for the whole row on one line.
								flexWrap: "wrap",
								gap: 12,
								paddingLeft: 20,
								paddingRight: 20,
								paddingTop: 10,
								paddingBottom: 10,
								borderBottomWidth: 1,
								borderColor: t.border,
								backgroundColor: selected ? t.bgActive : "transparent",
								cursor: "pointer",
								hover: { backgroundColor: selected ? t.bgActive : t.bgHover },
							}}
						>
							{/* Never lets the row lose its identity: it gives way to 140px and then
                  clamps, rather than shrinking to zero as it did with minWidth 0. */}
							<Col
								gap={2}
								style={{ flexGrow: 1, flexBasis: 210, minWidth: 140 }}
							>
								<Text size={13} weight={500} clamp={1}>
									{mode === "by-client"
										? l.clientName
										: `${l.reportNumber}  ${l.reportName}`}
								</Text>
								<Text color={t.textFaint} size={11.5} mono clamp={1}>
									{l.filePath.split("/").slice(-2).join("/")}
								</Text>
							</Col>

							<Badge
								label={l.kind.toUpperCase()}
								color={l.kind === "rdl" ? t.info : t.warn}
							/>
							{l.paramsXml ? null : <Badge label="no params" color={t.warn} />}

							{/* The first thing to give way — the detail pane shows it in full. */}
							<Col gap={2} style={{ flexBasis: 200, minWidth: 120 }}>
								<Text color={t.textDim} size={12} clamp={1}>
									{l.connection
										? connectionLabel(l.connection)
										: "no connection"}
								</Text>
								{l.connection?.lastStatus ? (
									<Text color={statusColor(l.connection.lastStatus)} size={11}>
										{l.connection.lastStatus}
									</Text>
								) : null}
							</Col>

							<Col gap={2} style={{ width: 130, flexShrink: 0 }}>
								<Text color={h.color} size={12}>
									{busy ? "rendering…" : h.label}
								</Text>
								{l.lastRender?.durationMs ? (
									<Text color={t.textFaint} size={11} mono>
										{`${l.lastRender.durationMs}ms`}
									</Text>
								) : null}
							</Col>

							<div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }} />

							{/*
                Always mounted, never revealed on hover. Mounting a button under the
                cursor is a trap: moving onto it can take the hover off the row that
                renders it, so it unmounts mid-gesture — the row flickers and the click
                never completes, which is exactly what "Render does nothing" was.
              */}
							<Row gap={6} style={{ flexShrink: 0 }}>
								<Button
									label={busy ? "…" : "Render"}
									onClick={() => onRender(l.id)}
									disabled={busy}
								/>
								<Button
									label="Agent"
									variant="primary"
									onClick={() => onSession(l.id)}
								/>
								<Button
									label="Params"
									variant="ghost"
									onClick={() => onEditParams(l)}
								/>
								<Button
									label="Duplicate"
									variant="ghost"
									onClick={() => onDuplicate(l)}
								/>
								<Button
									label="Remove"
									variant="ghost"
									onClick={() => onDelete(l)}
								/>
							</Row>
						</div>
					);
				})}
			</Col>
		</Scroll>
	);
}

/** The failure text for a row, pulled out of the stored render error. */
export function lastRenderError(l: LayoutDetail): string | null {
	if (!l.lastRender || l.lastRender.ok || !l.lastRender.error) return null;
	try {
		const parsed = JSON.parse(l.lastRender.error) as {
			kind?: string;
			bcMessage?: string;
			detail?: string;
		};
		return parsed.bcMessage ?? parsed.detail ?? l.lastRender.error;
	} catch {
		return l.lastRender.error;
	}
}
