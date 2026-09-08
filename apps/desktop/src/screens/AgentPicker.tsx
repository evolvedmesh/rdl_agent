/**
 * The provider picker: what "Agent" opens before any session exists.
 *
 * Starting a session used to pick the first runnable provider silently — which is
 * exactly how a machine with a broken node ended up appearing to "default to Copilot":
 * whichever provider happened to sort first past the ones that could not actually run.
 * This screen replaces that guess with a choice: every ACP-capable CLI this machine has
 * installed, shown with whether it can actually be launched right now, and nothing
 * starts until a person presses one.
 */

import {
	Badge,
	Button,
	Card,
	Col,
	gutter,
	IconButton,
	Measure,
	PageHeader,
	Row,
	Scroll,
	Text,
	useBreakpoint,
} from "../components/ui.tsx";
import { accentGradient, font, radius, shadow, t } from "../theme.ts";

export type PickableProvider = {
	id: string;
	name: string;
	version?: string;
	runnable: boolean;
	blocked?: string;
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
	const b = useBreakpoint();
	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<PageHeader
				title="Start an agent"
				subtitle={layoutTitle}
				compact={b.compact}
				leading={
					<IconButton glyph="‹" title="back" onClick={onBack} size={28} />
				}
			/>

			<Scroll style={{ padding: gutter(b) }}>
				<Measure max={640} gap={10}>
					{providers.length === 0 ? (
						<Card padding={20} gap={10}>
							<Text size={font.md} weight={600}>
								No ACP-capable CLI found
							</Text>
							<Text color={t.textDim} size={font.base} lineHeight={19}>
								Install Claude Code, GitHub Copilot CLI, Gemini CLI, Codex CLI
								or opencode, then come back to this screen.
							</Text>
						</Card>
					) : (
						providers.map((p) => {
							const busy = starting === p.id;
							return (
								<Card key={p.id} padding={14} gap={10}>
									<Row gap={12}>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												width: 34,
												height: 34,
												flexShrink: 0,
												borderRadius: radius.md,
												background: p.runnable ? accentGradient : t.bgRaised,
												borderWidth: 1,
												borderColor: p.runnable ? "#5b83d8" : t.border,
												boxShadow: p.runnable ? shadow.sm : undefined,
												opacity: p.runnable ? 1 : 0.6,
											}}
										>
											<text
												style={{
													color: p.runnable ? t.textOn : t.textFaint,
													fontSize: 14,
													fontWeight: 700,
												}}
											>
												{p.name.slice(0, 1).toUpperCase()}
											</text>
										</div>

										<Col gap={3} grow={1} style={{ minWidth: 0 }}>
											<Row gap={8}>
												<Text size={font.md} weight={600} clamp={1}>
													{p.name}
												</Text>
												<Badge
													label={p.runnable ? "ready" : "not runnable"}
													tone={p.runnable ? "ok" : "danger"}
													dot
												/>
											</Row>
											{p.version ? (
												<Text color={t.textFaint} size={font.xs} mono clamp={1}>
													{p.version}
												</Text>
											) : null}
										</Col>

										<Button
											label={busy ? "Starting…" : "Start"}
											variant="primary"
											onClick={() => onStart(p.id)}
											disabled={!p.runnable || starting !== null}
										/>
									</Row>

									{!p.runnable && p.blocked ? (
										<div
											style={{
												display: "flex",
												padding: 9,
												borderRadius: radius.sm,
												backgroundColor: t.dangerSoft,
												borderWidth: 1,
												borderColor: "#5c2f33",
											}}
										>
											<text style={{ color: t.danger, fontSize: font.sm }}>
												{p.blocked}
											</text>
										</div>
									) : null}
								</Card>
							);
						})
					)}
				</Measure>
			</Scroll>
		</Col>
	);
}
