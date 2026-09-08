/**
 * The clients × layouts table.
 *
 * The same rows serve the report page and the client page — one is the other pivoted,
 * which is why this is one component and one query rather than two of each. A consultant
 * onboarding a client thinks in the client direction; someone fixing a report thinks in
 * the report direction.
 *
 * A row is a wrapping flex line, not a grid: columns give way in a fixed order as the
 * pane narrows, and below that the secondary actions fold into a menu rather than being
 * pushed out of reach.
 */
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@gpuix/react/select";
import { connectionLabel, type LayoutDetail } from "@layout/core";
import {
	Badge,
	Button,
	Col,
	Dot,
	Empty,
	Row,
	Scroll,
	Text,
} from "../components/ui.tsx";
import { font, radius, statusColor, t } from "../theme.ts";

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
	compact,
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
	/** Fold the connection column and the secondary actions away. */
	compact: boolean;
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
				hint="Duplicate another client's layout to get started, or add one pointing at a file you already have."
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
								// pushed out of reach: this pane can be well under the width of the
								// whole row on one line.
								flexWrap: "wrap",
								gap: 10,
								paddingLeft: 16,
								paddingRight: 14,
								paddingTop: 11,
								paddingBottom: 11,
								borderBottomWidth: 1,
								borderColor: t.border,
								backgroundColor: selected ? t.bgActive : "transparent",
								cursor: "pointer",
								hover: { backgroundColor: selected ? t.bgActive : t.bgHover },
							}}
						>
							{/* Selection reads as a marker, not only as a fill: on a dark surface
                  the difference between bgActive and bgHover is a few percent. */}
							<div
								style={{
									width: 2,
									height: 26,
									flexShrink: 0,
									borderRadius: radius.pill,
									backgroundColor: selected ? t.accent : "transparent",
								}}
							/>

							{/* Never lets the row lose its identity: it gives way to 150px and then
                  clamps, rather than shrinking to zero as it did with minWidth 0. */}
							<Col
								gap={3}
								style={{ flexGrow: 1, flexBasis: 220, minWidth: 150 }}
							>
								<Row gap={7}>
									<Text size={font.md} weight={500} clamp={1}>
										{mode === "by-client"
											? l.clientName
											: `${l.reportNumber}  ${l.reportName}`}
									</Text>
									<Badge
										label={l.kind.toUpperCase()}
										tone={l.kind === "rdl" ? "info" : "warn"}
									/>
									{l.paramsXml ? null : <Badge label="no params" tone="warn" />}
								</Row>
								<Text color={t.textFaint} size={font.sm} mono clamp={1}>
									{l.filePath.split("/").slice(-2).join("/")}
								</Text>
							</Col>

							{/* The first thing to give way — the detail pane shows it in full. */}
							{compact ? null : (
								<Col gap={3} style={{ flexBasis: 190, minWidth: 130 }}>
									<Text color={t.textDim} size={font.sm} clamp={1}>
										{l.connection
											? connectionLabel(l.connection)
											: "no connection"}
									</Text>
									{l.connection?.lastStatus ? (
										<Row gap={5}>
											<Dot color={statusColor(l.connection.lastStatus)} />
											<Text color={t.textFaint} size={font.xs}>
												{l.connection.lastStatus}
											</Text>
										</Row>
									) : null}
								</Col>
							)}

							<Col gap={3} style={{ width: 118, flexShrink: 0 }}>
								<Row gap={5}>
									<Dot color={busy ? t.accent : h.color} />
									<Text color={busy ? t.accent : h.color} size={font.sm}>
										{busy ? "rendering…" : h.label}
									</Text>
								</Row>
								{l.lastRender?.durationMs ? (
									<Text color={t.textFaint} size={font.xs} mono>
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
									size="sm"
									onClick={() => onRender(l.id)}
									disabled={busy}
								/>
								<Button
									label="Agent"
									size="sm"
									variant="primary"
									onClick={() => onSession(l.id)}
								/>
								{compact ? (
									<RowMenu
										onParams={() => onEditParams(l)}
										onDuplicate={() => onDuplicate(l)}
										onDelete={() => onDelete(l)}
									/>
								) : (
									<>
										<Button
											label="Params"
											size="sm"
											variant="ghost"
											onClick={() => onEditParams(l)}
										/>
										<Button
											label="Duplicate"
											size="sm"
											variant="ghost"
											onClick={() => onDuplicate(l)}
										/>
										<Button
											label="Remove"
											size="sm"
											variant="ghost"
											onClick={() => onDelete(l)}
										/>
									</>
								)}
							</Row>
						</div>
					);
				})}
			</Col>
		</Scroll>
	);
}

/**
 * The secondary actions, folded into one control for a narrow pane. `Select` is the only
 * anchored popup GPUIX gives us, so it stands in for a menu: nothing is ever "selected",
 * each choice just runs its action and the value resets.
 */
function RowMenu({
	onParams,
	onDuplicate,
	onDelete,
}: {
	onParams: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	const run = (v: string) => {
		if (v === "params") onParams();
		else if (v === "duplicate") onDuplicate();
		else if (v === "delete") onDelete();
	};
	const items: { value: string; label: string; color: string }[] = [
		{ value: "params", label: "Edit parameters", color: t.text },
		{
			value: "duplicate",
			label: "Duplicate for another client",
			color: t.text,
		},
		{ value: "delete", label: "Remove layout", color: t.danger },
	];
	return (
		<Select value={undefined} onValueChange={run}>
			<SelectTrigger
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					width: 26,
					height: 24,
					borderRadius: radius.sm,
					borderWidth: 1,
					borderColor: t.borderStrong,
					backgroundColor: t.bgRaised,
					hover: { backgroundColor: t.bgHover },
				}}
			>
				<SelectValue placeholder="⋯">
					<text style={{ color: t.textDim, fontSize: 13 }}>⋯</text>
				</SelectValue>
			</SelectTrigger>
			<SelectContent
				style={{
					backgroundColor: t.bgRaised,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: radius.md,
					padding: 4,
				}}
			>
				{items.map((i) => (
					<SelectItem
						key={i.value}
						value={i.value}
						style={{
							paddingLeft: 9,
							paddingRight: 9,
							paddingTop: 6,
							paddingBottom: 6,
							borderRadius: radius.xs,
						}}
					>
						<text style={{ color: i.color, fontSize: font.base }}>
							{i.label}
						</text>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
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
