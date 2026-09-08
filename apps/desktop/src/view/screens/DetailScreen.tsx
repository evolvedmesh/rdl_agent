/**
 * A report or a client, as a master–detail split: the layouts on the left, the last
 * render of the selected one on the right.
 *
 * Below `compact` the split collapses to a single pane with a switcher — picking a row
 * is the gesture that means "show me this one", so it moves you across.
 */

import type { LayoutDetail } from "@layout/core";
import { useEffect, useState } from "react";
import type { Api } from "../api.ts";
import { PdfPane } from "../components/PdfPane.tsx";
import {
	Badge,
	Button,
	cx,
	Dot,
	Empty,
	IconButton,
	PageHeader,
	Segmented,
} from "../components/ui.tsx";
import { connectionLabel } from "../format.ts";
import { statusTone } from "../theme.ts";
import { LayoutTable, type LayoutTableMode } from "./LayoutTable.tsx";

type Pane = "layouts" | "preview";

export function DetailScreen(props: {
	api: Api;
	title: string;
	subtitle: string;
	mode: LayoutTableMode;
	layouts: LayoutDetail[];
	busyIds: Set<string>;
	selectedId: string | null;
	pageCount: number;
	renderVersion: number;
	onSelect: (id: string) => void;
	onRender: (id: string) => void;
	onSession: (id: string) => void;
	onDuplicate: (l: LayoutDetail) => void;
	onEditParams: (l: LayoutDetail) => void;
	onDelete: (l: LayoutDetail) => void;
	onAddLayout: () => void;
	onBack: () => void;
}) {
	const [pane, setPane] = useState<Pane>("layouts");
	const [isCompact, setIsCompact] = useState(
		() => !window.matchMedia("(min-width: 1180px)").matches,
	);
	const selected = props.layouts.find((l) => l.id === props.selectedId) ?? null;

	// The one place a media query is not enough: which pane is mounted is state, not
	// just visibility, because both panes scroll independently.
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 1180px)");
		const onChange = () => setIsCompact(!mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	const select = (id: string) => {
		props.onSelect(id);
		if (isCompact) setPane("preview");
	};

	const showList = !isCompact || pane === "layouts";
	const showPreview = !isCompact || pane === "preview";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="px-4 pt-4 compact:px-6 compact:pt-5">
				<div className="flex items-start gap-2">
					<IconButton label="back" onClick={props.onBack} className="mt-1">
						‹
					</IconButton>
					<div className="min-w-0 flex-1">
						<PageHeader
							title={props.title}
							subtitle={props.subtitle}
							actions={
								<Button variant="primary" onClick={props.onAddLayout}>
									<span aria-hidden="true">+</span> Add layout
								</Button>
							}
						/>
					</div>
				</div>

				{isCompact ? (
					<div className="pt-3">
						<Segmented<Pane>
							value={pane}
							onChange={setPane}
							className="w-full"
							options={[
								{
									value: "layouts",
									label: `Layouts (${props.layouts.length})`,
								},
								{ value: "preview", label: "Preview" },
							]}
						/>
					</div>
				) : null}
			</div>

			<div className="mt-3 flex min-h-0 flex-1 items-stretch border-t border-subtle">
				{showList ? (
					<div
						className={cx(
							"flex min-w-0 flex-1 basis-0 flex-col",
							!isCompact && "border-r border-subtle",
						)}
					>
						<LayoutTable
							layouts={props.layouts}
							mode={props.mode}
							busyIds={props.busyIds}
							selectedId={props.selectedId}
							onSelect={select}
							onRender={props.onRender}
							onSession={props.onSession}
							onDuplicate={props.onDuplicate}
							onEditParams={props.onEditParams}
							onDelete={props.onDelete}
						/>
					</div>
				) : null}

				{showPreview ? (
					<div className="flex min-w-0 flex-[1.15] basis-0 flex-col bg-canvas">
						{selected ? (
							<>
								<div className="shrink-0 border-b border-subtle bg-panel px-3.5 py-2.5">
									<div className="truncate text-base font-semibold">
										{selected.clientName} · {selected.reportNumber}
									</div>
									<div className="truncate font-mono text-xs text-faint">
										{selected.filePath}
									</div>
									<div className="mt-1 flex items-center gap-1.5 text-xs text-faint">
										<Dot
											tone={statusTone(
												selected.connection?.lastStatus ?? "never",
											)}
										/>
										<span className="truncate">
											{selected.connection
												? connectionLabel(selected.connection)
												: "no connection assigned"}
										</span>
									</div>
								</div>
								<PdfPane
									api={props.api}
									layoutId={selected.id}
									pageCount={props.pageCount}
									version={props.renderVersion}
									title="Preview"
									className="flex-1"
								/>
							</>
						) : (
							<div className="flex flex-1 items-center justify-center p-6">
								<Empty
									title="No layout selected"
									hint="Pick a row to see its last render here."
									action={
										isCompact ? (
											<Button
												variant="subtle"
												onClick={() => setPane("layouts")}
											>
												Back to layouts
											</Button>
										) : undefined
									}
								/>
							</div>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}

export { Badge };
