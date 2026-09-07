/**
 * The agent session: conversation, tool calls, plan, live cost, permission prompt, and
 * the rendered page side by side.
 *
 * Two things here are deliberate rather than decorative:
 *
 *   - the **first/last comparison** at the end of a session, so a human judges the
 *     result instead of the agent grading its own work
 *   - the **render queue**, shown while BC thinks. "Rendering 3 of 7, Acme queued behind
 *     Hawks" beats an app that appears frozen for two seconds a turn.
 *
 * Layout note: the chat scroller and the PDF scroller are siblings, never nested. GPUI
 * does not support nested scrolling — an inner scroller swallows the wheel gesture — and
 * a two-pane split is exactly the arrangement that stays legal.
 */

import type { EventPayload, PublicInstance } from "@gpuix/react";
import { useGpuix } from "@gpuix/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@gpuix/react/select";
import type { ConfigOption } from "@layout/acp";
import type { QueueSnapshot } from "@layout/core";
import type {
	PendingPermission,
	SessionView,
	TimelineItem,
	ToolCallView,
} from "@layout/server";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Api } from "../api.ts";
import { PdfPane } from "../components/PdfPane.tsx";
import { handleWordEdit } from "../components/textedit.ts";
import { Badge, Button, Col, Row, Text } from "../components/ui.tsx";
import { t } from "../theme.ts";

const statusTone: Record<string, string> = {
	starting: t.textDim,
	idle: t.ok,
	thinking: t.accent,
	"awaiting-permission": t.warn,
	error: t.danger,
	stopped: t.textFaint,
};

export function Session({
	api,
	session,
	queues,
	pageCount,
	renderVersion,
	layoutTitle,
	onClose,
}: {
	api: Api;
	session: SessionView;
	queues: QueueSnapshot[];
	pageCount: number;
	renderVersion: number;
	layoutTitle: string;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [resuming, setResuming] = useState(false);
	const [showFirst, setShowFirst] = useState(false);

	const busy = session.status === "thinking" || session.status === "starting";
	// No live agent behind it: a chat restored from a past run, or one that has been
	// stopped. The transcript still shows; the composer waits until it is resumed.
	const inactive = session.status === "stopped" || session.status === "error";

	const queued = queues.reduce((n, q) => n + q.depth, 0);

	const send = async () => {
		const text = draft.trim();
		if (!text || busy || inactive) return;
		setDraft("");
		setSending(true);
		try {
			await api.promptSession(session.id, text);
		} finally {
			setSending(false);
		}
	};

	const resume = async () => {
		setResuming(true);
		try {
			await api.resumeSession(session.id);
		} finally {
			setResuming(false);
		}
	};

	// Whatever this provider actually offers to adjust — every provider tested uses
	// "mode" for its permission mode and "model" for the model picker, which is what lets
	// one control work across Claude Code and opencode alike rather than a per-provider
	// switch. A provider with neither shows no controls, not a broken one.
	const modeOption = session.configOptions.find((o) => o.id === "mode");
	const modelOption = session.configOptions.find((o) => o.id === "model");

	const cost = useMemo(() => {
		const u = session.usage;
		const total = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
		const parts: string[] = [];
		if (total) parts.push(`${total.toLocaleString()} tokens`);
		if (u.costUsd !== undefined) parts.push(`$${u.costUsd.toFixed(4)}`);
		return parts.join(" · ");
	}, [session.usage]);

	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<Row
				gap={10}
				style={{
					paddingLeft: 16,
					paddingRight: 16,
					paddingTop: 10,
					paddingBottom: 10,
					borderBottomWidth: 1,
					borderColor: t.border,
					backgroundColor: t.bgPanel,
				}}
			>
				<Button label="‹ Back" variant="ghost" onClick={onClose} />
				<Col gap={2} style={{ minWidth: 0 }}>
					<Text size={13} weight={600} clamp={1}>
						{layoutTitle}
					</Text>
					<Text color={t.textFaint} size={11}>
						{`${session.providerName}${session.acceptsImages ? " · images supported" : " · text-only (no image capability)"}`}
					</Text>
				</Col>
				<div style={{ flexGrow: 1 }} />
				{queued > 0 ? (
					<Badge label={`rendering · ${queued} queued`} color={t.accent} />
				) : null}
				{cost ? (
					<Text color={t.textDim} size={11.5} mono>
						{cost}
					</Text>
				) : null}
				<Badge
					label={session.status}
					color={statusTone[session.status] ?? t.textDim}
				/>
				{busy ? (
					<Button
						label="Stop"
						variant="danger"
						onClick={() => void api.cancelSession(session.id)}
					/>
				) : null}
			</Row>

			<Row gap={0} grow={1} align="stretch" style={{ minHeight: 0 }}>
				{/* Left: conversation. Its own scroller. */}
				{/*
          flexShrink: 0 is load-bearing, not decorative — found by bisecting a real
          layout bug via screenshot: without it, `width: 460` is only a flex *basis*.
          Nested this many levels deep (sidebar row > content column > this row), Taffy
          let the fixed-width pane collapse toward its content's own min-content width
          alongside the flexGrow PDF pane, and long agent prose that had nowhere to
          wrap into rendered one word — sometimes one character — per line. Short tool
          titles never revealed it; only a real multi-sentence completion message did.
        */}
				<Col
					gap={0}
					style={{
						width: 460,
						minWidth: 0,
						flexShrink: 0,
						borderRightWidth: 1,
						borderColor: t.border,
					}}
				>
					{session.plan.length > 0 ? <Plan entries={session.plan} /> : null}

					<ConversationScroller
						timeline={session.timeline}
						error={session.error}
					/>

					{session.permission ? (
						<PermissionPrompt
							permission={session.permission}
							onAnswer={(id) => void api.answerPermission(session.id, id)}
						/>
					) : null}

					{inactive ? (
						<ResumeBar
							restored={session.restored}
							error={session.error}
							resuming={resuming}
							onResume={() => void resume()}
						/>
					) : null}

					<Composer
						value={draft}
						onChange={setDraft}
						onSend={send}
						disabled={busy || sending || inactive}
						modeOption={modeOption}
						modelOption={modelOption}
						modeId={session.modeId}
						providerName={session.providerName}
						onSetMode={(v) => void api.setSessionMode(session.id, v)}
						onSetModel={(v) => void api.setSessionModel(session.id, v)}
					/>
				</Col>

				{/* Right: the render. A sibling scroller, never nested inside the chat's. */}
				<Col gap={0} grow={1} style={{ minWidth: 0 }}>
					{session.firstPdfPath &&
					session.latestPdfPath &&
					session.firstPdfPath !== session.latestPdfPath ? (
						<Row
							gap={8}
							style={{
								paddingLeft: 12,
								paddingRight: 12,
								paddingTop: 6,
								paddingBottom: 6,
								backgroundColor: t.bgRaised,
								borderBottomWidth: 1,
								borderColor: t.border,
							}}
						>
							<Text color={t.textDim} size={11.5}>
								{showFirst
									? "Showing the first render of this session"
									: "Showing the latest render"}
							</Text>
							<div style={{ flexGrow: 1 }} />
							<Button
								label={showFirst ? "Show latest" : "Compare with first"}
								variant="ghost"
								onClick={() => setShowFirst((v) => !v)}
							/>
						</Row>
					) : null}

					<PdfPane
						api={api}
						layoutId={session.layoutId}
						pageCount={pageCount}
						version={showFirst ? 0 : renderVersion}
						title={layoutTitle}
					/>
				</Col>
			</Row>
		</Col>
	);
}

/**
 * The conversation, in plain top-to-bottom order.
 *
 * This used to be `flexDirection: "column-reverse"` with a reversed child order — the
 * standard CSS trick for "always show the newest message" with no imperative scroll
 * API. It does not hold up here: nested this many levels deep (sidebar row > content
 * column > two-pane row > this list), GPUI's layout engine stopped treating the
 * container as a column at all and laid every child out left-to-right instead —
 * confirmed live, not just suspected. Plain `column`, forward order, is what every
 * isolated test actually rendered correctly, so that is what this is now.
 *
 * Auto-follow is back, done properly: GPUIX's renderer *does* expose `scrollTo` and
 * `getScrollOffset` (keyed by the element id a ref hands back). We keep the view pinned
 * to the bottom as the agent streams, and stop following the moment the reader scrolls
 * up — re-pinning only when they scroll back down to the end, or send a new message. If
 * the renderer lacks those methods it degrades to the old no-follow behaviour rather
 * than breaking.
 */
function ConversationScroller({
	timeline,
	error,
}: {
	timeline: TimelineItem[];
	error: string | null;
}) {
	const { renderer } = useGpuix();
	const scrollRef = useRef<PublicInstance | null>(null);
	/** Follow new content to the bottom. Turned off when the reader scrolls up. */
	const stickRef = useRef(true);
	/** The scroll offset (negative px) observed at the bottom on the last pin. */
	const bottomYRef = useRef(0);
	/** Ignore the `scroll` events our own `scrollTo` provokes. */
	const selfScrollUntilRef = useRef(0);
	/** The id of the newest user turn, so a fresh prompt re-pins the view. */
	const lastUserIdRef = useRef<string | null>(null);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el || !renderer?.scrollTo) return;
		selfScrollUntilRef.current = Date.now() + 150;
		// A large negative y; the renderer clamps to the real maximum.
		renderer.scrollTo(el.id, 0, -1e6);
		const off = renderer.getScrollOffset?.(el.id);
		if (off && typeof off[1] === "number") bottomYRef.current = off[1];
	}, [renderer]);

	// A cheap fingerprint of everything on screen: it changes on a new item, a streamed
	// token, a tool-call status flip, or an error — every case we might need to follow.
	const contentSig = useMemo(() => {
		let n = timeline.length + (error?.length ?? 0);
		for (const i of timeline) {
			n +=
				i.kind === "message"
					? i.text.length
					: i.call.title.length +
						i.call.status.length +
						(i.call.diffPatch?.length ?? 0) +
						(i.call.preview?.length ?? 0);
		}
		return n;
	}, [timeline, error]);

	// A new user message means "I just asked something" — always jump back to the end.
	useEffect(() => {
		for (let i = timeline.length - 1; i >= 0; i--) {
			const item = timeline[i];
			if (item?.kind === "message" && item.role === "user") {
				if (lastUserIdRef.current !== item.id) {
					lastUserIdRef.current = item.id;
					stickRef.current = true;
				}
				break;
			}
		}
	}, [timeline]);

	useEffect(() => {
		if (!stickRef.current) return;
		// Two frames: the new content has to be laid out before we can scroll past it.
		const a = setTimeout(scrollToBottom, 0);
		const b = setTimeout(scrollToBottom, 60);
		return () => {
			clearTimeout(a);
			clearTimeout(b);
		};
	}, [contentSig, scrollToBottom]);

	const onScroll = useCallback(
		(_e: EventPayload) => {
			if (Date.now() < selfScrollUntilRef.current) return;
			const el = scrollRef.current;
			const off = el ? renderer?.getScrollOffset?.(el.id) : null;
			if (!off || typeof off[1] !== "number") return;
			// y is negative; less-negative means scrolled up, away from the bottom.
			const distanceFromBottom = off[1] - bottomYRef.current;
			stickRef.current = distanceFromBottom < 24;
		},
		[renderer],
	);

	const blocks = useMemo<{ key: string; node: ReactNode }[]>(() => {
		const out: { key: string; node: ReactNode }[] = [];
		if (timeline.length === 0) {
			out.push({
				key: "hint",
				node: (
					<Col gap={6}>
						<Text color={t.textDim} size={12.5}>
							Describe the change you want.
						</Text>
						<Text color={t.textFaint} size={11.5}>
							The agent can render this layout, read the page as text, diff the
							geometry against the previous render, look at a page image, and
							trace a rendered value back to the element that produced it.
						</Text>
					</Col>
				),
			});
		} else {
			for (const item of timeline) {
				out.push({
					key: item.id,
					node:
						item.kind === "message" ? (
							<Message role={item.role} text={item.text} />
						) : (
							<ToolCallRow call={item.call} />
						),
				});
			}
		}
		if (error) {
			out.push({
				key: "session-error",
				node: (
					<div
						style={{
							display: "flex",
							padding: 10,
							borderRadius: 6,
							borderWidth: 1,
							borderColor: "#5c2f33",
							backgroundColor: "#2a1719",
						}}
					>
						<text style={{ color: t.danger, fontSize: 12 }}>{error}</text>
					</div>
				),
			});
		}
		return out;
	}, [timeline, error]);

	return (
		<div
			ref={scrollRef}
			onScroll={onScroll}
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "stretch",
				gap: 10,
				overflowY: "scroll",
				flexGrow: 1,
				minHeight: 0,
				padding: 14,
			}}
		>
			{blocks.map((b) => (
				// alignSelf/minWidth are not decoration here: without them a flex item's
				// default min-width (its content's own intrinsic minimum, not 0) wins the fight
				// against the parent's width in this deeply nested layout, and every block
				// collapses to the width of its longest unbreakable token — confirmed by
				// screenshot. Independent of, and still needed after, dropping column-reverse.
				<div
					key={b.key}
					style={{
						display: "flex",
						flexDirection: "column",
						alignSelf: "stretch",
						minWidth: 0,
					}}
				>
					{b.node}
				</div>
			))}
		</div>
	);
}

function Message({
	role,
	text,
}: {
	role: "agent" | "user" | "thought";
	text: string;
}) {
	if (role === "thought") {
		return (
			<div style={{ display: "flex", paddingLeft: 8 }}>
				<text style={{ color: t.textFaint, fontSize: 11.5 }}>{text}</text>
			</div>
		);
	}
	const isUser = role === "user";
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				padding: 10,
				borderRadius: 8,
				backgroundColor: isUser ? t.bgActive : t.bgPanel,
				borderWidth: 1,
				borderColor: isUser ? t.borderStrong : t.border,
			}}
		>
			{isUser ? (
				<text style={{ color: t.text, fontSize: 12.5 }}>{text}</text>
			) : (
				// markdown is native here — no npm dependency to style and keep current.
				<markdown source={text} style={{ color: t.text, fontSize: 12.5 }} />
			)}
		</div>
	);
}

function Plan({
	entries,
}: {
	entries: { content: string; status?: string; priority?: string }[];
}) {
	return (
		<Col
			gap={5}
			style={{
				padding: 12,
				backgroundColor: t.bgRaised,
				borderBottomWidth: 1,
				borderColor: t.border,
			}}
		>
			<Text color={t.textDim} size={11} weight={600}>
				PLAN
			</Text>
			{entries.map((e, i) => (
				<Row key={i} gap={7} align="flex-start">
					<text
						style={{
							color:
								e.status === "completed"
									? t.ok
									: e.status === "in_progress"
										? t.accent
										: t.textFaint,
							fontSize: 12,
						}}
					>
						{e.status === "completed"
							? "●"
							: e.status === "in_progress"
								? "◐"
								: "○"}
					</text>
					<text
						style={{
							color: e.status === "completed" ? t.textFaint : t.text,
							fontSize: 12,
						}}
					>
						{e.content}
					</text>
				</Row>
			))}
		</Col>
	);
}

/**
 * One tool call, inline at the point in the conversation where it actually happened —
 * not lumped into a separate list at the end regardless of timing, which is what made
 * it impossible to tell which edit belonged to which request.
 *
 * The diff is the point: `call.diffPatch` is a real unified-diff patch built from the
 * edit's own before/after text (see `unifiedDiff` in @layout/feedback), rendered with
 * GPUIX's native `<diff>` element. Without it, an edit was a title and a checkmark —
 * which is the entire reason "did it actually change the file" was unanswerable from
 * the chat alone.
 */
function ToolCallRow({ call }: { call: ToolCallView }) {
	const tone =
		call.status === "failed"
			? t.danger
			: call.status === "completed"
				? t.ok
				: t.accent;
	const glyph =
		call.status === "failed" ? "✕" : call.status === "completed" ? "✓" : "…";

	return (
		<Col gap={5} style={{ minWidth: 0, paddingTop: 2, paddingBottom: 2 }}>
			{/*
        minWidth: 0 on the row and its title cell, one-line clamp on the title itself:
        a tool call's title can be a whole shell command with nowhere natural to break,
        and without this it did not wrap so much as paint straight past the pane's edge
        and overlap the row below it — confirmed by screenshot, the same collapse this
        file fixes twice already, for the message text and the code/diff blocks.
      */}
			<Row gap={7} style={{ minWidth: 0 }}>
				<text style={{ color: tone, fontSize: 11 }}>{glyph}</text>
				<Col style={{ flexGrow: 1, minWidth: 0 }}>
					<Text color={t.textDim} size={11.5} mono clamp={1}>
						{call.title}
					</Text>
				</Col>
				{call.kind ? <Badge label={call.kind} color={t.textFaint} /> : null}
			</Row>
			{call.locations.length > 0 ? (
				// clamp: an absolute temp-dir path is one long token with almost no natural
				// break point, and letting it wrap free is what collapsed it to one path
				// segment per line the same way the tool title did above. Nobody needs three
				// wrapped lines of /tmp/... in a chat transcript anyway — one truncated line
				// is the right call on its own merits, not just a workaround.
				<Text
					color={t.textFaint}
					size={10.5}
					mono
					clamp={1}
					style={{ paddingLeft: 18 }}
				>
					{call.locations.join(", ")}
				</Text>
			) : null}
			{call.diffPatch ? (
				// A horizontal-only scroller, not the diff's own vertical one: `<diff>` does
				// not wrap long lines, and RDL's XML runs well past this pane's width — without
				// this the line text was clipped at the edge with no way to reach the rest of
				// it (confirmed by screenshot: `scroll` on `<diff>` itself was rejected because
				// it is a *vertical* scroller, which nests inside this list's own and steals
				// the wheel; horizontal scroll never competes with the vertical wheel gesture,
				// so it is safe here the same way PdfPane already scrolls both axes on one div).
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						minWidth: 0,
						marginLeft: 18,
						overflowX: "scroll",
					}}
				>
					<diff
						patch={call.diffPatch}
						wordDiff
						scroll={false}
						maxLines={200}
						style={{
							borderRadius: 6,
							borderWidth: 1,
							borderColor: t.border,
							fontSize: 11,
						}}
					/>
				</div>
			) : call.preview ? (
				// Same fix, same reason as the diff above: <code> renders one line per div at
				// a fixed height and does not wrap, so unconstrained it painted straight past
				// this pane's edge — visually indistinguishable, in a screenshot, from the pane
				// itself having grown. A horizontal-only scroller contains it without competing
				// for the vertical wheel this list already owns.
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						minWidth: 0,
						marginLeft: 18,
						overflowX: "scroll",
					}}
				>
					<code
						code={call.preview}
						language="text"
						style={{
							fontSize: 11,
							backgroundColor: t.bg,
							borderRadius: 6,
							padding: 8,
							maxHeight: 160,
						}}
					/>
				</div>
			) : null}
		</Col>
	);
}

/**
 * Shown above the composer when there is no live agent behind the chat — either it was
 * restored from a previous run, or it has been stopped. The transcript stays readable
 * above; this bar is the way back into it.
 */
function ResumeBar({
	restored,
	error,
	resuming,
	onResume,
}: {
	restored: boolean;
	error: string | null;
	resuming: boolean;
	onResume: () => void;
}) {
	return (
		<Col
			gap={7}
			style={{
				padding: 11,
				backgroundColor: t.bgRaised,
				borderTopWidth: 1,
				borderColor: t.border,
			}}
		>
			<Text color={t.textDim} size={11.5}>
				{restored
					? "This conversation was restored from a previous run."
					: "This conversation has stopped."}
			</Text>
			{error ? (
				<Text color={t.danger} size={11}>
					{error}
				</Text>
			) : null}
			<Row gap={7}>
				<Button
					label={resuming ? "Resuming…" : "Resume"}
					variant="primary"
					onClick={onResume}
					disabled={resuming}
				/>
			</Row>
		</Col>
	);
}

/**
 * Permission is never auto-granted for a write. The policy layer allows reads and our
 * own layout_* tools silently; anything that changes a customer's layout stops here.
 */
function PermissionPrompt({
	permission,
	onAnswer,
}: {
	permission: PendingPermission;
	onAnswer: (optionId: string | null) => void;
}) {
	return (
		<Col
			gap={9}
			style={{
				padding: 12,
				backgroundColor: "#2a2416",
				borderTopWidth: 1,
				borderColor: "#4a3f20",
			}}
		>
			<Text color={t.warn} size={12} weight={600}>
				The agent is asking for permission
			</Text>
			<Text color={t.text} size={12.5}>
				{permission.title}
			</Text>
			{permission.rawInput ? (
				// overflowX, not wrap: <code> renders one line per div and does not wrap, and
				// this is exactly the JSON that carries the edit's old/new text in full — the
				// one place in this dialog someone would actually want to read a long value
				// completely rather than have it clipped at the box edge.
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						minWidth: 0,
						overflowX: "scroll",
					}}
				>
					<code
						code={JSON.stringify(permission.rawInput, null, 2).slice(0, 800)}
						language="json"
						style={{
							fontSize: 11,
							backgroundColor: t.bg,
							borderRadius: 6,
							padding: 8,
							maxHeight: 160,
						}}
					/>
				</div>
			) : null}
			<Row gap={7} wrap>
				{permission.options.map((o) => (
					<Button
						key={o.optionId}
						label={o.name}
						variant={o.kind.startsWith("allow") ? "primary" : "default"}
						onClick={() => onAnswer(o.optionId)}
					/>
				))}
				<Button
					label="Cancel turn"
					variant="ghost"
					onClick={() => onAnswer(null)}
				/>
			</Row>
		</Col>
	);
}

/**
 * The message box, with the permission-mode and model pickers built into it as small
 * pills — the ChatGPT-composer pattern: controls that change how the next turn behaves
 * live where you're about to send it, not in a separate bar up in the header where they
 * read as page chrome rather than something you're about to use.
 */
function Composer({
	value,
	onChange,
	onSend,
	disabled,
	modeOption,
	modelOption,
	modeId,
	providerName,
	onSetMode,
	onSetModel,
}: {
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	disabled: boolean;
	modeOption?: ConfigOption;
	modelOption?: ConfigOption;
	modeId: string | null;
	providerName: string;
	onSetMode: (modeId: string) => void;
	onSetModel: (modelId: string) => void;
}) {
	return (
		<Col
			gap={7}
			style={{
				padding: 11,
				borderTopWidth: 1,
				borderColor: t.border,
				backgroundColor: t.bgPanel,
			}}
		>
			<textarea
				value={value}
				placeholder="Do this and that.."
				minRows={2}
				maxRows={6}
				onChange={(e) => onChange(e.value ?? "")}
				// Enter does not reach onKeyDown at all for this native textarea — confirmed
				// live: typing fires keyDown per character, but pressing Enter fires neither
				// keyDown nor keyUp, only this dedicated `onSubmit`. Shift+Enter needs no
				// handler here — it already inserts a newline at the native level with no JS
				// event of its own, confirmed the same way.
				onSubmit={() => onSend()}
				// Ctrl/Alt+Backspace isn't in GPUIX 0.7's Linux keymap; polyfill it. See
				// components/textedit.ts for what this does and does not cover.
				onKeyDown={(e) => handleWordEdit(e, value, onChange)}
				style={{
					backgroundColor: t.bg,
					color: t.text,
					fontSize: 12.5,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: 7,
					paddingLeft: 9,
					paddingRight: 9,
					paddingTop: 7,
					paddingBottom: 7,
				}}
			/>
			<Row gap={7}>
				{modeOption ? (
					<PickerPill
						value={modeId}
						options={modeOption.options.map((o) => ({
							value: o.value,
							label: o.name,
						}))}
						onChange={onSetMode}
						placeholder="Mode"
					/>
				) : null}
				{modelOption ? (
					<PickerPill
						value={modelOption.currentValue ?? null}
						options={modelOption.options.map((o) => ({
							value: o.value,
							label: o.name,
						}))}
						onChange={onSetModel}
						placeholder="Model"
					/>
				) : null}
				{!modeOption && !modelOption ? (
					<Text color={t.textFaint} size={10.5}>
						{`${providerName} has no permission mode or model to switch here.`}
					</Text>
				) : null}
				<div style={{ flexGrow: 1 }} />
				<Text color={t.textFaint} size={11}>
					Enter to send
				</Text>
				<Button
					label="Send"
					variant="primary"
					onClick={onSend}
					disabled={disabled || !value.trim()}
				/>
			</Row>
		</Col>
	);
}

/**
 * A compact, pill-shaped picker — the same `Select` primitive `Dropdown` (forms.tsx)
 * uses, without its label line, since a toolbar strip has no room for one and the
 * current value read as a pill already says what it is (a mode, a model).
 */
function PickerPill({
	value,
	options,
	onChange,
	placeholder,
}: {
	value: string | null;
	options: { value: string; label: string }[];
	onChange: (v: string) => void;
	placeholder: string;
}) {
	const current = options.find((o) => o.value === value);
	return (
		<Select value={value ?? undefined} onValueChange={onChange}>
			<SelectTrigger
				style={{
					backgroundColor: t.bgRaised,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: 999,
					paddingLeft: 10,
					paddingRight: 10,
					paddingTop: 4,
					paddingBottom: 4,
				}}
			>
				<SelectValue placeholder={placeholder}>
					<text
						style={{ color: current ? t.textDim : t.textFaint, fontSize: 11 }}
					>
						{current?.label ?? placeholder}
					</text>
				</SelectValue>
			</SelectTrigger>
			<SelectContent
				style={{
					backgroundColor: t.bgRaised,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: 8,
					padding: 4,
				}}
			>
				{options.map((o) => (
					<SelectItem
						key={o.value}
						value={o.value}
						style={{
							paddingLeft: 8,
							paddingRight: 8,
							paddingTop: 5,
							paddingBottom: 5,
							borderRadius: 5,
						}}
					>
						<text style={{ color: t.text, fontSize: 12 }}>{o.label}</text>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
