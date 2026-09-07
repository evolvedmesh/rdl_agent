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

import { Badge, Button, Card, Col, Row, Text } from "../components/ui.tsx";
import { t } from "../theme.ts";

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
	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<Row
				gap={10}
				style={{
					paddingLeft: 16,
					paddingRight: 20,
					paddingTop: 12,
					paddingBottom: 12,
					borderBottomWidth: 1,
					borderColor: t.border,
				}}
			>
				<Button label="‹ Back" variant="ghost" onClick={onBack} />
				<Col gap={2} style={{ minWidth: 0 }}>
					<Text size={16} weight={600} clamp={1}>
						Start an agent
					</Text>
					<Text color={t.textFaint} size={12}>
						{layoutTitle}
					</Text>
				</Col>
			</Row>

			<Col gap={10} style={{ padding: 20, maxWidth: 560 }}>
				{providers.length === 0 ? (
					<Text color={t.textDim} size={13}>
						No ACP-capable CLI was found on this machine. Install Claude Code,
						GitHub Copilot CLI, Gemini CLI, Codex CLI or opencode, and reopen
						this dialog.
					</Text>
				) : (
					providers.map((p) => {
						const busy = starting === p.id;
						return (
							<Card key={p.id} padding={14}>
								<Row gap={10}>
									<Col gap={3} grow={1} style={{ minWidth: 0 }}>
										<Row gap={8}>
											<Text size={13.5} weight={500}>
												{p.name}
											</Text>
											{p.runnable ? (
												<Badge label="ready" color={t.ok} />
											) : (
												<Badge label="not runnable" color={t.danger} />
											)}
										</Row>
										{p.version ? (
											<Text color={t.textFaint} size={11} mono>
												{p.version}
											</Text>
										) : null}
										{!p.runnable && p.blocked ? (
											<Text color={t.danger} size={11.5}>
												{p.blocked}
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
							</Card>
						);
					})
				)}
			</Col>
		</Col>
	);
}
