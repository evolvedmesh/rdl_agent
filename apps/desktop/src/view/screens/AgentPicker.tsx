/**
 * The provider picker: what "Agent" opens before any session exists.
 *
 * Starting a session used to pick the first runnable provider silently — which is
 * exactly how a machine with a broken node ended up appearing to "default to Copilot":
 * whichever provider happened to sort first past the ones that could not actually run.
 * This screen replaces that guess with a choice.
 */

import { motion } from "motion/react";
import {
	Badge,
	Button,
	Card,
	cx,
	IconButton,
	PageHeader,
	Spinner,
} from "../components/ui.tsx";

export type PickableProvider = {
	id: string;
	name: string;
	version?: string;
	runnable: boolean;
	blocked?: string;
	/** A caveat worth reading before starting a session with this provider. */
	note?: string;
};

export function AgentPicker({
	layoutTitle,
	providers,
	starting,
	onStart,
	onBack,
}: {
	layoutTitle: string;
	providers: PickableProvider[];
	/** The provider id currently being started, so only its own row shows "Starting…". */
	starting: string | null;
	onStart: (providerId: string) => void;
	onBack: () => void;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-start gap-2 px-4 pt-4 compact:px-6 compact:pt-5">
				<IconButton label="back" onClick={onBack} className="mt-1">
					‹
				</IconButton>
				<div className="min-w-0 flex-1">
					<PageHeader title="Start an agent" subtitle={layoutTitle} />
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-4 compact:p-6">
				<div className="mx-auto flex max-w-160 flex-col gap-2.5">
					{providers.length === 0 ? (
						<Card className="flex flex-col gap-2.5 p-5">
							<div className="text-base font-semibold">
								No ACP-capable CLI found
							</div>
							<p className="text-base leading-5 text-dim">
								Install Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI
								or opencode, then come back to this screen.
							</p>
						</Card>
					) : (
						providers.map((p, i) => {
							const busy = starting === p.id;
							return (
								<motion.div
									key={p.id}
									initial={{ opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.2, delay: i * 0.04 }}
								>
									<Card className="flex flex-col gap-2.5 p-3.5">
										<div className="flex items-center gap-3">
											<div
												className={cx(
													"flex size-9 shrink-0 items-center justify-center rounded-md border text-sm font-bold",
													p.runnable
														? "accent-fill border-[#5b83d8] text-on shadow-raise"
														: "border-subtle bg-raised text-faint opacity-60",
												)}
											>
												{p.name.slice(0, 1).toUpperCase()}
											</div>

											<div className="flex min-w-0 flex-1 flex-col gap-0.5">
												<div className="flex items-center gap-2">
													<span className="truncate text-base font-semibold">
														{p.name}
													</span>
													<Badge tone={p.runnable ? "ok" : "danger"}>
														<span
															className="size-1.5 rounded-full bg-current"
															aria-hidden="true"
														/>
														{p.runnable ? "ready" : "not runnable"}
													</Badge>
												</div>
												{p.version ? (
													<span className="truncate font-mono text-xs text-faint">
														{p.version}
													</span>
												) : null}
											</div>

											<Button
												variant="primary"
												onClick={() => onStart(p.id)}
												disabled={!p.runnable || starting !== null}
											>
												{busy ? (
													<>
														<Spinner /> Starting…
													</>
												) : (
													"Start"
												)}
											</Button>
										</div>

										{!p.runnable && p.blocked ? (
											<p className="rounded-sm border border-danger-line bg-danger-soft p-2.5 text-sm text-danger">
												{p.blocked}
											</p>
										) : p.note ? (
											<p className="rounded-sm border border-warn-line bg-warn-soft p-2.5 text-sm text-warn">
												{p.note}
											</p>
										) : null}
									</Card>
								</motion.div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
