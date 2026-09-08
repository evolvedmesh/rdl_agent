/**
 * The clients × layouts table.
 *
 * The same rows serve the report page and the client page — one is the other pivoted,
 * which is why this is one component and one query rather than two of each. A consultant
 * onboarding a client thinks in the client direction; someone fixing a report thinks in
 * the report direction.
 */

import type { LayoutDetail } from "@layout/core";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { motion } from "motion/react";
import {
	Badge,
	Button,
	cx,
	Dot,
	Empty,
	IconButton,
	PulseDot,
} from "../components/ui.tsx";
import { connectionLabel } from "../format.ts";
import { statusTone } from "../theme.ts";

export type LayoutTableMode = "by-client" | "by-report";

function health(l: LayoutDetail): { label: string; className: string } {
	if (!l.lastRender)
		return { label: "never rendered", className: "text-faint" };
	if (!l.lastRender.ok)
		return { label: "render failed", className: "text-danger" };
	const mins = Math.round(
		(Date.now() - new Date(l.lastRender.createdAt).getTime()) / 60000,
	);
	const when =
		mins < 1
			? "just now"
			: mins < 60
				? `${mins}m ago`
				: `${Math.round(mins / 60)}h ago`;
	return { label: `ok ${when}`, className: "text-ok" };
}

/** The render state of one layout, shown in a column or under the name as it folds. */
function Health({ l, busy }: { l: LayoutDetail; busy: boolean }) {
	const h = health(l);
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 text-sm",
				busy ? "text-accent" : h.className,
			)}
		>
			{busy ? (
				<PulseDot tone="accent" />
			) : (
				<Dot
					tone={l.lastRender ? (l.lastRender.ok ? "ok" : "danger") : "neutral"}
				/>
			)}
			{busy ? "rendering…" : h.label}
		</span>
	);
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
			<div className="p-4">
				<Empty
					title="No layouts here yet"
					hint="Duplicate another client's layout to get started, or add one pointing at a file you already have."
				/>
			</div>
		);
	}

	return (
		// A container query, not a media query: this pane is one half of a split, so its
		// width has little to do with the window's. Columns fold on the pane's own size.
		<div className="@container min-h-0 flex-1 overflow-y-auto">
			{layouts.map((l, i) => {
				const selected = l.id === selectedId;
				const busy = busyIds.has(l.id);
				return (
					<motion.div
						key={l.id}
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0.15, delay: Math.min(i * 0.02, 0.2) }}
						onClick={() => onSelect(l.id)}
						className={cx(
							"group flex cursor-pointer items-center gap-2.5 border-b border-subtle py-2.5 pr-3.5 pl-4",
							"transition-colors duration-150",
							selected ? "bg-active" : "hover:bg-hover",
						)}
					>
						{/* Selection reads as a marker, not only as a fill: on a dark surface
						    the difference between active and hover is a few percent. */}
						<span
							className={cx(
								"h-6 w-0.5 shrink-0 rounded-full",
								selected ? "bg-accent" : "bg-transparent",
							)}
						/>

						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-base font-medium">
									{mode === "by-client"
										? l.clientName
										: `${l.reportNumber}  ${l.reportName}`}
								</span>
								<Badge tone={l.kind === "rdl" ? "info" : "warn"}>
									{l.kind.toUpperCase()}
								</Badge>
								{l.paramsXml ? null : <Badge tone="warn">no params</Badge>}
							</div>
							<span className="truncate font-mono text-sm text-faint">
								{l.filePath.split("/").slice(-2).join("/")}
							</span>
							{/* Below the fold width these two ride under the name instead of
							    getting their own columns. */}
							<div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 @2xl:hidden">
								<Health l={l} busy={busy} />
								<span className="truncate text-xs text-faint">
									{l.connection
										? connectionLabel(l.connection)
										: "no connection"}
								</span>
							</div>
						</div>

						{/* The first thing to give way — the detail pane shows it in full. */}
						<div className="hidden min-w-0 flex-[0_1_190px] flex-col gap-0.5 @4xl:flex">
							<span className="truncate text-sm text-dim">
								{l.connection ? connectionLabel(l.connection) : "no connection"}
							</span>
							{l.connection?.lastStatus ? (
								<span className="flex items-center gap-1.5 text-xs text-faint">
									<Dot tone={statusTone(l.connection.lastStatus)} />
									{l.connection.lastStatus}
								</span>
							) : null}
						</div>

						<div className="hidden w-29.5 shrink-0 flex-col gap-0.5 @2xl:flex">
							<Health l={l} busy={busy} />
							{l.lastRender?.durationMs ? (
								<span className="font-mono text-xs text-faint tabular-nums">
									{l.lastRender.durationMs}ms
								</span>
							) : null}
						</div>

						{/*
						  Always mounted, never revealed on hover. Mounting a button under the
						  cursor is a trap: moving onto it can take the hover off the row that
						  renders it, so it unmounts mid-gesture — the row flickers and the
						  click never completes.
						*/}
						<div
							className="flex shrink-0 items-center gap-1.5"
							onClick={(e) => e.stopPropagation()}
						>
							<Button size="sm" onClick={() => onRender(l.id)} disabled={busy}>
								{busy ? "…" : "Render"}
							</Button>
							<Button
								size="sm"
								variant="primary"
								onClick={() => onSession(l.id)}
							>
								Agent
							</Button>
							<RowMenu
								onParams={() => onEditParams(l)}
								onDuplicate={() => onDuplicate(l)}
								onDelete={() => onDelete(l)}
							/>
						</div>
					</motion.div>
				);
			})}
		</div>
	);
}

function RowMenu({
	onParams,
	onDuplicate,
	onDelete,
}: {
	onParams: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	const item =
		"flex cursor-pointer items-center rounded-xs px-2.5 py-1.5 text-base outline-none " +
		"data-highlighted:bg-hover";
	return (
		<Menu.Root>
			<Menu.Trigger asChild>
				<IconButton
					label="more actions"
					className="border border-strong bg-raised"
				>
					<span aria-hidden="true">⋯</span>
				</IconButton>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					sideOffset={4}
					align="end"
					className="z-50 min-w-50 rounded-md border border-strong bg-raised p-1 shadow-float"
				>
					<Menu.Item className={cx(item, "text-fg")} onSelect={onParams}>
						Edit parameters
					</Menu.Item>
					<Menu.Item className={cx(item, "text-fg")} onSelect={onDuplicate}>
						Duplicate for another client
					</Menu.Item>
					<Menu.Separator className="my-1 h-px bg-subtle" />
					<Menu.Item className={cx(item, "text-danger")} onSelect={onDelete}>
						Remove layout
					</Menu.Item>
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
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
