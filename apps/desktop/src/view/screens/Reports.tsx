/**
 * Home — one card per report. The projection a consultant opens the app to see:
 * which reports exist, how many clients have a layout for each, and whether the last
 * render for each of them worked.
 *
 * The measured column count the GPUIX version needed is now `auto-fill` — CSS grid
 * keeps every card the same width for free.
 */

import { motion } from "motion/react";
import type { ReportCard } from "../api.ts";
import { Badge, Button, Card, PageHeader, Stat } from "../components/ui.tsx";
import { statusLabel, statusTone } from "../theme.ts";

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
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="px-4 pt-4 compact:px-6 compact:pt-6">
				<PageHeader
					title="Reports"
					subtitle={`${reports.length} report${reports.length === 1 ? "" : "s"} · ${stats.count} render${stats.count === 1 ? "" : "s"} recorded`}
					actions={
						<>
							{/* duration_ms on every render row quietly answers the BC latency
							    question over real use, so it is worth surfacing. */}
							{stats.p50Ms !== null ? (
								<div className="hidden items-center gap-2 compact:flex">
									<Stat label="p50" value={`${stats.p50Ms}ms`} />
									<Stat label="p95" value={`${stats.p95Ms}ms`} />
									<div className="mx-1 h-6 w-px bg-subtle" />
								</div>
							) : null}
							<Button variant="subtle" onClick={onAddLayout}>
								Add layout
							</Button>
							<Button variant="primary" onClick={onAddReport}>
								<span aria-hidden="true">+</span> Add report
							</Button>
						</>
					}
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4 compact:p-6">
				{reports.length === 0 ? (
					<Onboarding onAddReport={onAddReport} onAddLayout={onAddLayout} />
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(292px,1fr))] gap-3.5">
						{reports.map((r, i) => (
							<motion.div
								key={r.id}
								initial={{ opacity: 0, y: 8 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{
									duration: 0.2,
									delay: Math.min(i * 0.025, 0.3),
									ease: "easeOut",
								}}
							>
								<Card
									interactive
									onClick={() => onOpen(r.id)}
									className="flex h-full flex-col gap-2 p-3.5"
								>
									<div className="flex items-center gap-2">
										<span className="shrink-0 rounded-xs border border-accent-line bg-accent-soft px-1.5 py-0.5 font-mono text-sm font-semibold text-accent-hi">
											{r.reportId}
										</span>
										<span className="flex-1" />
										<Badge tone={statusTone(r.health)}>
											<span
												className="size-1.5 rounded-full bg-current"
												aria-hidden="true"
											/>
											{statusLabel(r.health)}
										</Badge>
									</div>

									<div className="line-clamp-2 text-base font-medium">
										{r.name}
									</div>

									{r.source ? (
										<div className="truncate font-mono text-xs text-faint">
											{r.source}
										</div>
									) : null}

									<div className="mt-auto flex items-center gap-3.5 border-t border-subtle pt-2 text-sm text-dim">
										<span>
											{r.clientCount} client{r.clientCount === 1 ? "" : "s"}
										</span>
										<span>
											{r.layoutCount} layout{r.layoutCount === 1 ? "" : "s"}
										</span>
										<span className="flex-1" />
										<span className="text-faint transition-transform duration-200 group-hover:translate-x-0.5">
											Open ›
										</span>
									</div>
								</Card>
							</motion.div>
						))}
					</div>
				)}
			</div>
		</div>
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
		<div className="mx-auto max-w-155 pt-6">
			<Card className="flex flex-col gap-3.5 p-6">
				<div>
					<div className="text-lg font-semibold">Nothing set up yet</div>
					<p className="mt-1 text-base text-dim">
						Four things, in order — Settings covers the first two.
					</p>
				</div>

				<ol className="flex flex-col gap-2.5">
					{steps.map((s, i) => (
						<li key={s} className="flex items-start gap-2.5">
							<span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-strong bg-raised text-xs text-dim">
								{i + 1}
							</span>
							<span className="min-w-0 flex-1 text-base leading-5 text-dim">
								{s}
							</span>
						</li>
					))}
				</ol>

				<div className="flex gap-2 pt-1">
					<Button variant="primary" onClick={onAddReport}>
						Add a report
					</Button>
					<Button variant="subtle" onClick={onAddLayout}>
						Add a layout
					</Button>
				</div>
			</Card>
		</div>
	);
}
