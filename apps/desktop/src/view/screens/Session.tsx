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
 */

import type { ConfigOption } from "@layout/acp";
import type { QueueSnapshot } from "@layout/core";
import type {
	PendingPermission,
	SessionView,
	TimelineItem,
	ToolCallView,
} from "@layout/server";
import { AnimatePresence, motion } from "motion/react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Api } from "../api.ts";
import { CodeBlock, DiffBlock } from "../components/Diff.tsx";
import { Dropdown } from "../components/forms.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { PdfPane } from "../components/PdfPane.tsx";
import {
	Badge,
	Button,
	cx,
	Dot,
	IconButton,
	PulseDot,
	Segmented,
	Spinner,
} from "../components/ui.tsx";
import type { Tone } from "../theme.ts";

const statusToneOf = (status: string): Tone => {
	switch (status) {
		case "idle":
			return "ok";
		case "thinking":
		case "starting":
			return "accent";
		case "awaiting-permission":
			return "warn";
		case "error":
			return "danger";
		default:
			return "neutral";
	}
};

type Pane = "chat" | "preview";

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
	const [pane, setPane] = useState<Pane>("chat");
	const [isCompact, setIsCompact] = useState(
		() => !window.matchMedia("(min-width: 1180px)").matches,
	);

	useEffect(() => {
		const mq = window.matchMedia("(min-width: 1180px)");
		const onChange = () => setIsCompact(!mq.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

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

	const showChat = !isCompact || pane === "chat";
	const showPreview = !isCompact || pane === "preview";
	const canCompare =
		Boolean(session.firstPdfPath) &&
		Boolean(session.latestPdfPath) &&
		session.firstPdfPath !== session.latestPdfPath;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 flex-col gap-2 border-b border-subtle bg-panel py-2 pr-3 pl-2.5">
				<div className="flex items-center gap-2.5">
					<IconButton label="back" onClick={onClose}>
						‹
					</IconButton>
					<div className="min-w-0 flex-1">
						<div className="truncate text-base font-semibold">
							{layoutTitle}
						</div>
						<div className="truncate text-xs text-faint">
							{session.providerName}
							{session.acceptsImages
								? " · images supported"
								: " · text-only (no image capability)"}
						</div>
					</div>
					{queued > 0 ? (
						<Badge tone="accent">
							<PulseDot tone="accent" />
							{queued} queued
						</Badge>
					) : null}
					{/* Renders spent, and how many of them moved nothing — the two numbers
					    that say whether this session is converging or thrashing. */}
					{session.loop.iterations > 0 ? (
						<Badge
							tone={session.loop.noOpRenders > 0 ? "warn" : "neutral"}
							title={
								`${session.loop.iterations} render(s), ` +
								`${session.loop.noOpRenders} that moved nothing, ` +
								`${session.loop.failedRenders} failed`
							}
						>
							{session.loop.iterations} render
							{session.loop.iterations === 1 ? "" : "s"}
							{session.loop.noOpRenders > 0
								? ` · ${session.loop.noOpRenders} no-op`
								: ""}
						</Badge>
					) : null}
					{cost ? (
						<span className="hidden font-mono text-xs text-dim compact:inline">
							{cost}
						</span>
					) : null}
					<Badge tone={statusToneOf(session.status)}>
						{busy ? (
							<PulseDot tone={statusToneOf(session.status)} />
						) : (
							<Dot tone={statusToneOf(session.status)} />
						)}
						{session.status}
					</Badge>
					{busy ? (
						<Button
							size="sm"
							variant="danger"
							onClick={() => void api.cancelSession(session.id)}
						>
							Stop
						</Button>
					) : null}
				</div>

				{isCompact ? (
					<Segmented<Pane>
						value={pane}
						onChange={setPane}
						className="w-full"
						options={[
							{ value: "chat", label: "Conversation" },
							{ value: "preview", label: "Preview" },
						]}
					/>
				) : null}
			</header>

			<div className="flex min-h-0 flex-1 items-stretch">
				{showChat ? (
					<div
						className={cx(
							"flex min-w-0 flex-col bg-canvas",
							isCompact
								? "flex-1"
								: "w-[clamp(400px,36%,560px)] shrink-0 border-r border-subtle",
						)}
					>
						{session.plan.length > 0 ? <Plan entries={session.plan} /> : null}

						<Conversation timeline={session.timeline} error={session.error} />

						<AnimatePresence>
							{session.permission ? (
								<PermissionPrompt
									permission={session.permission}
									onAnswer={(id) => void api.answerPermission(session.id, id)}
								/>
							) : null}
						</AnimatePresence>

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
							busy={busy}
							modeOption={modeOption}
							modelOption={modelOption}
							modeId={session.modeId}
							providerName={session.providerName}
							onSetMode={(v) => void api.setSessionMode(session.id, v)}
							onSetModel={(v) => void api.setSessionModel(session.id, v)}
						/>
					</div>
				) : null}

				{showPreview ? (
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						{canCompare ? (
							<div
								className={cx(
									"flex shrink-0 items-center gap-2 border-b py-1.5 pr-2 pl-3",
									showFirst
										? "border-warn-line bg-warn-soft"
										: "border-subtle bg-raised",
								)}
							>
								<Dot tone={showFirst ? "warn" : "neutral"} />
								<span
									className={cx(
										"truncate text-sm",
										showFirst ? "text-warn" : "text-dim",
									)}
								>
									{showFirst
										? "Showing the first render of this session"
										: "Showing the latest render"}
								</span>
								<span className="flex-1" />
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setShowFirst((v) => !v)}
								>
									{showFirst ? "Show latest" : "Compare with first"}
								</Button>
							</div>
						) : null}

						<PdfPane
							api={api}
							layoutId={session.layoutId}
							pageCount={pageCount}
							version={showFirst ? 0 : renderVersion}
							title={layoutTitle}
							className="flex-1"
						/>
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * The conversation, pinned to the bottom while the agent streams and released the
 * moment the reader scrolls up — re-pinning when they scroll back to the end or send.
 */
function Conversation({
	timeline,
	error,
}: {
	timeline: TimelineItem[];
	error: string | null;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const lastUserId = useRef<string | null>(null);

	// A new user message means "I just asked something" — always jump back to the end.
	useEffect(() => {
		for (let i = timeline.length - 1; i >= 0; i--) {
			const item = timeline[i];
			if (item?.kind === "message" && item.role === "user") {
				if (lastUserId.current !== item.id) {
					lastUserId.current = item.id;
					stick.current = true;
				}
				break;
			}
		}
	}, [timeline]);

	// A cheap fingerprint of everything on screen: it changes on a new item, a streamed
	// token, a tool-call status flip, or an error — every case we might need to follow.
	const sig = useMemo(() => {
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

	useLayoutEffect(() => {
		const el = ref.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [sig]);

	const onScroll = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
	}, []);

	return (
		<div
			ref={ref}
			onScroll={onScroll}
			className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5"
		>
			{timeline.length === 0 ? <ConversationHint /> : null}

			{timeline.map((item) => (
				<motion.div
					key={item.id}
					initial={{ opacity: 0, y: 6 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.18, ease: "easeOut" }}
					className="flex min-w-0 flex-col"
				>
					{item.kind === "message" ? (
						<Message role={item.role} text={item.text} />
					) : (
						<ToolCallRow call={item.call} />
					)}
				</motion.div>
			))}

			{error ? (
				<p className="rounded-md border border-danger-line bg-danger-soft p-3 text-base wrap-break-word text-danger">
					{error}
				</p>
			) : null}
		</div>
	);
}

function ConversationHint() {
	const abilities = [
		"render this layout against Business Central",
		"read the rendered page back as text",
		"diff the geometry against the previous render",
		"look at a page image",
		"trace a rendered value back to the element that produced it",
	];
	return (
		<div className="flex flex-col gap-3 pt-1.5">
			<h2 className="text-base font-semibold">Describe the change you want</h2>
			<ul className="flex flex-col gap-1.5">
				{abilities.map((a) => (
					<li key={a} className="flex items-start gap-2">
						<span className="mt-1.5 size-1 shrink-0 rounded-full bg-accent-dim" />
						<span className="min-w-0 flex-1 text-sm leading-[1.45] text-faint">
							{a}
						</span>
					</li>
				))}
			</ul>
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
			<div className="flex gap-2 pl-0.5">
				<span className="w-0.5 shrink-0 self-stretch rounded-full bg-subtle" />
				<p className="min-w-0 text-sm leading-[1.45] wrap-break-word text-faint italic">
					{text}
				</p>
			</div>
		);
	}
	const isUser = role === "user";
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex items-center gap-1.5">
				<Dot tone={isUser ? "accent" : "ok"} />
				<span className="text-2xs font-semibold text-faint">
					{isUser ? "YOU" : "AGENT"}
				</span>
			</div>
			<div
				className={cx(
					"min-w-0 rounded-lg border px-3 py-2.5",
					isUser
						? "border-accent-line bg-accent-soft"
						: "border-subtle bg-panel",
				)}
			>
				{isUser ? (
					<p className="text-base leading-normal wrap-break-word whitespace-pre-wrap">
						{text}
					</p>
				) : (
					<Markdown source={text} />
				)}
			</div>
		</div>
	);
}

function Plan({
	entries,
}: {
	entries: { content: string; status?: string; priority?: string }[];
}) {
	const done = entries.filter((e) => e.status === "completed").length;
	const pct = entries.length ? (done / entries.length) * 100 : 0;
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b border-subtle bg-panel px-3.5 py-2.5">
			<div className="flex items-center gap-2">
				<span className="text-2xs font-semibold tracking-wide text-faint">
					PLAN
				</span>
				<span className="flex-1" />
				<span className="font-mono text-2xs text-faint tabular-nums">
					{done}/{entries.length}
				</span>
			</div>

			{/* A bar, not a spinner: the only honest progress signal available is how many
			    of the agent's own steps it has closed. */}
			<div className="h-0.75 overflow-hidden rounded-full bg-sunken">
				<motion.div
					className="h-full rounded-full bg-ok"
					initial={false}
					animate={{ width: `${pct}%` }}
					transition={{ duration: 0.35, ease: "easeOut" }}
				/>
			</div>

			<ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
				{entries.map((e, i) => (
					<li key={`${i}-${e.content}`} className="flex items-start gap-2">
						<span
							className={cx(
								"shrink-0 text-base leading-[1.35]",
								e.status === "completed"
									? "text-ok"
									: e.status === "in_progress"
										? "text-accent"
										: "text-faint",
							)}
						>
							{e.status === "completed"
								? "●"
								: e.status === "in_progress"
									? "◐"
									: "○"}
						</span>
						<span
							className={cx(
								"min-w-0 flex-1 text-base leading-[1.35]",
								e.status === "completed"
									? "text-faint line-through"
									: "text-fg",
							)}
						>
							{e.content}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * One tool call, inline at the point in the conversation where it actually happened —
 * not lumped into a separate list at the end regardless of timing, which is what made
 * it impossible to tell which edit belonged to which request.
 *
 * Collapsed by default once complete: a finished call is a line of history, and an
 * expanded diff for every one of twenty calls buries the prose between them.
 */
function ToolCallRow({ call }: { call: ToolCallView }) {
	const hasBody = Boolean(call.diffPatch || call.preview);
	const [open, setOpen] = useState(call.status !== "completed");

	const tone =
		call.status === "failed"
			? "text-danger"
			: call.status === "completed"
				? "text-ok"
				: "text-accent";
	const glyph =
		call.status === "failed" ? "✕" : call.status === "completed" ? "✓" : null;

	return (
		<div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-subtle bg-sunken px-2.5 py-2">
			<button
				type="button"
				onClick={() => hasBody && setOpen((v) => !v)}
				className={cx(
					"flex min-w-0 items-center gap-2 text-left",
					hasBody ? "cursor-pointer" : "cursor-default",
				)}
			>
				<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-raised text-[9px]">
					{glyph ? (
						<span className={tone}>{glyph}</span>
					) : (
						<Spinner className="size-2.5 text-accent" />
					)}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-sm text-dim">
					{call.title}
				</span>
				{call.kind ? <Badge>{call.kind}</Badge> : null}
				{hasBody ? (
					<span
						className={cx(
							"shrink-0 text-faint transition-transform duration-200",
							open && "rotate-90",
						)}
					>
						›
					</span>
				) : null}
			</button>

			{call.locations.length > 0 ? (
				// One truncated line: an absolute temp-dir path is a long unbreakable token,
				// and nobody needs three wrapped lines of /tmp/… in a transcript.
				<div
					className="truncate pl-6 font-mono text-xs text-faint"
					title={call.locations.join(", ")}
				>
					{call.locations.join(", ")}
				</div>
			) : null}

			<AnimatePresence initial={false}>
				{open && hasBody ? (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.2, ease: "easeOut" }}
						className="min-w-0 overflow-hidden pl-6"
					>
						{call.diffPatch ? (
							<DiffBlock patch={call.diffPatch} />
						) : call.preview ? (
							<CodeBlock code={call.preview} />
						) : null}
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

/**
 * Shown above the composer when there is no live agent behind the chat — either it was
 * restored from a previous run, or it has been stopped.
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
		<div className="flex shrink-0 items-center gap-2.5 border-t border-subtle bg-raised px-3.5 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-sm text-dim">
					{restored
						? "This conversation was restored from a previous run."
						: "This conversation has stopped."}
				</span>
				{error ? (
					<span className="line-clamp-2 text-xs text-danger">{error}</span>
				) : null}
			</div>
			<Button variant="primary" onClick={onResume} disabled={resuming}>
				{resuming ? (
					<>
						<Spinner /> Resuming…
					</>
				) : (
					"Resume"
				)}
			</Button>
		</div>
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
		<motion.div
			initial={{ height: 0, opacity: 0 }}
			animate={{ height: "auto", opacity: 1 }}
			exit={{ height: 0, opacity: 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="shrink-0 overflow-hidden border-t border-warn-line bg-warn-soft"
		>
			<div className="flex flex-col gap-2.5 p-3">
				<div className="flex items-center gap-1.5">
					<PulseDot tone="warn" />
					<span className="text-sm font-semibold text-warn">
						PERMISSION REQUESTED
					</span>
				</div>
				<p className="text-base leading-normal wrap-break-word">
					{permission.title}
				</p>
				{permission.rawInput ? (
					<CodeBlock
						code={JSON.stringify(permission.rawInput, null, 2).slice(0, 800)}
					/>
				) : null}
				<div className="flex flex-wrap gap-1.5">
					{permission.options.map((o) => (
						<Button
							key={o.optionId}
							size="sm"
							variant={o.kind.startsWith("allow") ? "primary" : "default"}
							onClick={() => onAnswer(o.optionId)}
						>
							{o.name}
						</Button>
					))}
					<Button size="sm" variant="ghost" onClick={() => onAnswer(null)}>
						Cancel turn
					</Button>
				</div>
			</div>
		</motion.div>
	);
}

/**
 * The message box, with the permission-mode and model pickers built into it as small
 * pills — controls that change how the next turn behaves live where you're about to
 * send it, not up in the header where they read as page chrome.
 */
function Composer({
	value,
	onChange,
	onSend,
	disabled,
	busy,
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
	busy: boolean;
	modeOption?: ConfigOption;
	modelOption?: ConfigOption;
	modeId: string | null;
	providerName: string;
	onSetMode: (modeId: string) => void;
	onSetModel: (modelId: string) => void;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);

	// Grow with the content, up to a ceiling — a fixed two rows hides most of a
	// paragraph-length instruction while it is being written.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
	}, [value]);

	return (
		<div className="flex shrink-0 flex-col gap-2 border-t border-subtle bg-panel p-2.5">
			<textarea
				ref={ref}
				value={value}
				rows={2}
				placeholder={
					busy ? "The agent is working…" : "Describe the change you want…"
				}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						onSend();
					}
				}}
				className={cx(
					"w-full resize-none rounded-md border border-strong bg-sunken px-2.5 py-2",
					"text-base leading-[1.4] shadow-raise transition-colors duration-150",
					"placeholder:text-faint hover:border-focus focus:border-focus focus:outline-none",
				)}
			/>
			<div className="flex flex-wrap items-center gap-1.5">
				{modeOption ? (
					<div className="w-36">
						<Dropdown
							value={modeId ?? undefined}
							options={modeOption.options.map((o) => ({
								value: o.value,
								label: o.name,
							}))}
							onChange={onSetMode}
							placeholder="Mode"
						/>
					</div>
				) : null}
				{modelOption ? (
					<div className="w-44">
						<Dropdown
							value={modelOption.currentValue ?? undefined}
							options={modelOption.options.map((o) => ({
								value: o.value,
								label: o.name,
							}))}
							onChange={onSetModel}
							placeholder="Model"
						/>
					</div>
				) : null}
				{!modeOption && !modelOption ? (
					<span className="truncate text-xs text-faint">
						{providerName} has no permission mode or model to switch here.
					</span>
				) : null}
				<span className="flex-1" />
				<span className="hidden text-xs text-faint compact:inline">
					Enter to send
				</span>
				<Button
					variant="primary"
					size="sm"
					onClick={onSend}
					disabled={disabled || !value.trim()}
				>
					Send
				</Button>
			</div>
		</div>
	);
}
