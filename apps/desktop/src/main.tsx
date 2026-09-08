/**
 * The desktop shell.
 *
 * GPUIX runs GPUI's native event loop on a dedicated Rust UI thread on Linux and
 * Windows, so Bun's event loop stays free — which is why the core process (HTTP server,
 * WebSocket, render engine, ACP subprocesses, MCP server) can live in this same process
 * rather than being spawned as a sidecar. The UI still talks to it over localhost, so
 * nothing here is load-bearing for the core: a browser can drive the same server.
 *
 * The shell has three shapes, chosen from the window width alone (`useBreakpoint`):
 * a docked sidebar beside a two-pane screen; a docked sidebar beside a single pane; and
 * — narrowest — an app bar with the sidebar as an overlay. There are no media queries
 * in GPUI, so every one of those branches is explicit.
 */

import { render } from "@gpuix/react";
import type { DetectedProvider } from "@layout/acp";
import { connectionLabel } from "@layout/core";
import { runStdioShim } from "@layout/mcp";
import { createApp } from "@layout/server";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Api,
	type AppState,
	type CredentialStatus,
	type ServerMessage,
} from "./api.ts";
import { PdfPane } from "./components/PdfPane.tsx";
import {
	Badge,
	type Breakpoint,
	Button,
	Col,
	Dot,
	IconButton,
	PageHeader,
	Row,
	SectionLabel,
	Segmented,
	Spacer,
	Text,
	useBreakpoint,
} from "./components/ui.tsx";
import { AgentPicker } from "./screens/AgentPicker.tsx";
import { Dialog, type DialogKind } from "./screens/dialogs.tsx";
import { LayoutTable } from "./screens/LayoutTable.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Session } from "./screens/Session.tsx";
import { Settings } from "./screens/Settings.tsx";
import {
	accentGradient,
	font,
	radius,
	shadow,
	statusColor,
	t,
} from "./theme.ts";

// This one binary is the whole app. Before booting the GPUI window, honour the two
// non-GUI ways it gets invoked:
//   <app> mcp-shim --stdio --session <id>   the per-session MCP proxy an agent spawns
//   <app> serve                             headless core, for a browser to drive
// A compiled build re-execs itself for the shim (process.execPath is this binary); in
// dev the entrypoint routes the same args. Everything below is GUI-only.
const cliArgs = process.argv.slice(2);

if (cliArgs[0] === "mcp-shim" || cliArgs.includes("--stdio")) {
	await runStdioShim(cliArgs);
	process.exit(0);
}

if (cliArgs[0] === "serve" || cliArgs[0] === "--headless") {
	const app = await createApp();
	console.log(
		`layout-agent listening on http://localhost:${app.server.port}` +
			(app.replaying ? "  (REPLAY MODE)" : ""),
	);
	process.on("SIGINT", () => {
		void app.shutdown().then(() => process.exit(0));
	});
	await new Promise(() => {}); // serve until killed; never fall through to the GUI
}

const core = await createApp();
const api = new Api(`http://127.0.0.1:${core.server.port}`);
console.error(
	`[layout] core listening on ${api.base}${core.replaying ? "  (REPLAY MODE)" : ""}`,
);

type Route =
	| { name: "reports" }
	| { name: "report"; reportId: string }
	| { name: "client"; clientId: string }
	| { name: "settings" }
	/** The provider picker for a layout that has no session open yet. */
	| { name: "agent"; layoutId: string }
	| { name: "session"; sessionId: string };

const EMPTY: AppState = {
	reports: [],
	clients: [],
	connections: [],
	layouts: [],
	queues: [],
	stats: { count: 0, okCount: 0, p50Ms: null, p95Ms: null },
	sessions: [],
};

const SIDEBAR_WIDTH = 244;

function App() {
	const b = useBreakpoint();
	const [route, setRoute] = useState<Route>({ name: "reports" });
	const [state, setState] = useState<AppState>(EMPTY);
	const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
	const [providers, setProviders] = useState<DetectedProvider[]>([]);
	const [busy, setBusy] = useState<Set<string>>(new Set());
	const [selectedLayout, setSelectedLayout] = useState<string | null>(null);
	const [renderVersion, setRenderVersion] = useState(0);
	const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
	const [toast, setToast] = useState<string | null>(null);
	const [dialog, setDialog] = useState<DialogKind | null>(null);
	/** Only consulted while the sidebar is an overlay; a docked one is always visible. */
	const [navOpen, setNavOpen] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const [s, c] = await Promise.all([api.state(), api.credentials()]);
			setState(s);
			setCredentials(c);
		} catch (e) {
			setToast(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
		void api.providers().then(setProviders);

		// The socket is the live half: render progress and agent output arrive here, so the
		// UI never has to poll to look alive.
		return api.connect((m: ServerMessage) => {
			if (m.channel === "render") {
				setState((prev) => ({ ...prev, queues: m.queues }));
				const ev = m.event as {
					type: string;
					layoutId?: string;
					result?: { ok: boolean; pageCount?: number };
				};
				if (ev.type === "finished") {
					setBusy((prev) => {
						const next = new Set(prev);
						if (ev.layoutId) next.delete(ev.layoutId);
						return next;
					});
					if (ev.result?.ok && ev.layoutId) {
						const layoutId = ev.layoutId;
						const pageCount = ev.result.pageCount ?? 1;
						setPageCounts((prev) => ({
							...prev,
							[layoutId]: pageCount,
						}));
						setRenderVersion((v) => v + 1);
					}
					void refresh();
				}
				if (ev.type === "queued" && ev.layoutId) {
					const layoutId = ev.layoutId;
					setBusy((prev) => new Set(prev).add(layoutId));
				}
			}
			if (m.channel === "session") void refresh();
		});
	}, [refresh]);

	// A toast that never leaves is chrome; one that leaves too fast is missed. Six
	// seconds is long enough to read a BC error and short enough not to become furniture.
	useEffect(() => {
		if (!toast) return;
		const id = setTimeout(() => setToast(null), 6000);
		return () => clearTimeout(id);
	}, [toast]);

	// A docked sidebar cannot be "closed", so leaving the overlay state set would hide
	// the content behind a scrim the moment the window was widened.
	useEffect(() => {
		if (!b.narrow) setNavOpen(false);
	}, [b.narrow]);

	const doRender = useCallback(
		async (layoutId: string) => {
			setBusy((prev) => new Set(prev).add(layoutId));
			try {
				await api.render(layoutId, true);
			} catch (e) {
				setToast(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy((prev) => {
					const next = new Set(prev);
					next.delete(layoutId);
					return next;
				});
				void refresh();
			}
		},
		[refresh],
	);

	// Set only while a session is being created, and to which provider — so the picker
	// can show "Starting…" on the one row someone actually pressed rather than the whole
	// list going busy.
	const [startingProvider, setStartingProvider] = useState<string | null>(null);

	const startSessionWithProvider = useCallback(
		async (layoutId: string, providerId: string) => {
			const provider = providers.find((p) => p.id === providerId);
			// Defensive only: the picker already disables a row that is not runnable, so
			// reaching here with one means the provider list changed under the click.
			if (!provider?.runnable) {
				setToast(
					provider
						? `${provider.name} cannot be started: ${provider.blocked}.`
						: `Unknown provider "${providerId}".`,
				);
				return;
			}
			setStartingProvider(providerId);
			try {
				const session = await api.createSession(layoutId, provider.id);
				await refresh();
				setRoute({ name: "session", sessionId: session.id });
			} catch (e) {
				setToast(e instanceof Error ? e.message : String(e));
			} finally {
				setStartingProvider(null);
			}
		},
		[providers, refresh],
	);

	const navigate = useCallback((r: Route) => {
		setRoute(r);
		setNavOpen(false);
	}, []);

	const activeSession =
		route.name === "session"
			? state.sessions.find((s) => s.id === route.sessionId)
			: undefined;

	const layoutsFor = useMemo(() => {
		if (route.name === "report")
			return state.layouts.filter((l) => l.reportId === route.reportId);
		if (route.name === "client")
			return state.layouts.filter((l) => l.clientId === route.clientId);
		return state.layouts;
	}, [route, state.layouts]);

	const selected = state.layouts.find((l) => l.id === selectedLayout) ?? null;

	const layoutTitleFor = useCallback(
		(layoutId: string) => {
			const l = state.layouts.find((x) => x.id === layoutId);
			return l ? `${l.reportNumber} · ${l.clientName}` : "Layout";
		},
		[state.layouts],
	);

	const detailTitle =
		route.name === "report"
			? (() => {
					const r = state.reports.find((x) => x.id === route.reportId);
					return r ? `${r.reportId} · ${r.name}` : "Report";
				})()
			: route.name === "client"
				? (state.clients.find((c) => c.id === route.clientId)?.name ?? "Client")
				: "";

	const sidebar = (
		<Sidebar
			route={route}
			state={state}
			onNavigate={navigate}
			replaying={core.replaying}
			port={core.server.port ?? 0}
			floating={b.narrow}
			onDismiss={() => setNavOpen(false)}
		/>
	);

	return (
		// `position: relative` so the modal overlay and the sidebar drawer can be
		// absolutely positioned over the whole app: GPUIX is single-window with no portal
		// to escape to.
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				height: "100%",
				backgroundColor: t.bg,
				position: "relative",
			}}
		>
			{b.narrow ? null : sidebar}

			<Col gap={0} grow={1} style={{ minWidth: 0, minHeight: 0 }}>
				{b.narrow ? (
					<AppBar
						replaying={core.replaying}
						onMenu={() => setNavOpen((v) => !v)}
					/>
				) : null}

				{activeSession ? (
					<Session
						api={api}
						session={activeSession}
						queues={state.queues}
						pageCount={pageCounts[activeSession.layoutId] ?? 1}
						renderVersion={renderVersion}
						layoutTitle={layoutTitleFor(activeSession.layoutId)}
						onClose={() => navigate({ name: "reports" })}
					/>
				) : route.name === "agent" ? (
					<AgentPicker
						layoutTitle={layoutTitleFor(route.layoutId)}
						providers={providers}
						starting={startingProvider}
						onStart={(providerId) =>
							void startSessionWithProvider(route.layoutId, providerId)
						}
						onBack={() => navigate({ name: "reports" })}
					/>
				) : route.name === "reports" ? (
					<Reports
						reports={state.reports}
						stats={state.stats}
						onOpen={(reportId) => navigate({ name: "report", reportId })}
						onAddReport={() => setDialog({ kind: "add-report" })}
						onAddLayout={() => setDialog({ kind: "add-layout" })}
					/>
				) : route.name === "settings" ? (
					<Settings
						api={api}
						credentials={credentials}
						clients={state.clients}
						connections={state.connections}
						onChanged={refresh}
						onAddClient={() => setDialog({ kind: "add-client" })}
						onAddConnection={(c) =>
							setDialog({
								kind: "add-connection",
								clientId: c.id,
								clientName: c.name,
							})
						}
					/>
				) : (
					<DetailScreen
						title={detailTitle}
						subtitle={
							route.name === "report"
								? `${layoutsFor.length} client layout${layoutsFor.length === 1 ? "" : "s"}`
								: `${layoutsFor.length} report${layoutsFor.length === 1 ? "" : "s"}`
						}
						mode={route.name === "report" ? "by-client" : "by-report"}
						layouts={layoutsFor}
						busyIds={busy}
						queues={state.queues}
						selectedId={selectedLayout}
						onSelect={setSelectedLayout}
						onRender={doRender}
						onSession={(layoutId) => navigate({ name: "agent", layoutId })}
						onBack={() => navigate({ name: "reports" })}
						pageCount={selected ? (pageCounts[selected.id] ?? 1) : 1}
						renderVersion={renderVersion}
						onDuplicate={(l) => setDialog({ kind: "duplicate", layout: l })}
						onEditParams={(l) => setDialog({ kind: "edit-params", layout: l })}
						onDelete={(l) => setDialog({ kind: "delete-layout", layout: l })}
						onAddLayout={() =>
							setDialog({
								kind: "add-layout",
								reportId: route.name === "report" ? route.reportId : undefined,
							})
						}
					/>
				)}
			</Col>

			{toast ? (
				<Toast message={toast} onDismiss={() => setToast(null)} />
			) : null}

			{b.narrow && navOpen ? (
				<div
					onClick={() => setNavOpen(false)}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						display: "flex",
						flexDirection: "row",
						backgroundColor: t.overlay,
					}}
				>
					{sidebar}
				</div>
			) : null}

			{dialog ? (
				<Dialog
					dialog={dialog}
					api={api}
					clients={state.clients}
					connections={state.connections}
					reports={state.reports}
					onClose={() => setDialog(null)}
					onDone={() => {
						setDialog(null);
						void refresh();
					}}
				/>
			) : null}
		</div>
	);
}

/** The narrow-window title strip. The only place the drawer toggle lives. */
function AppBar({
	replaying,
	onMenu,
}: {
	replaying: boolean;
	onMenu: () => void;
}) {
	return (
		<Row
			gap={10}
			style={{
				paddingLeft: 10,
				paddingRight: 12,
				paddingTop: 7,
				paddingBottom: 7,
				borderBottomWidth: 1,
				borderColor: t.border,
				backgroundColor: t.bgPanel,
				flexShrink: 0,
			}}
		>
			<IconButton glyph="☰" title="menu" onClick={onMenu} size={28} />
			<Text size={font.base} weight={600}>
				Layout Agent
			</Text>
			<Spacer />
			{replaying ? <Badge label="replay" tone="warn" dot /> : null}
		</Row>
	);
}

/** A dismissible notice, floating clear of the layout rather than pushing it down. */
function Toast({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				bottom: 16,
				display: "flex",
				flexDirection: "row",
				justifyContent: "center",
				// The strip spans the window so the card can centre in it; only the card
				// itself should take a click.
				pointerEvents: "none",
			}}
		>
			<Row
				gap={12}
				style={{
					maxWidth: 720,
					paddingLeft: 14,
					paddingRight: 8,
					paddingTop: 9,
					paddingBottom: 9,
					borderRadius: radius.lg,
					borderWidth: 1,
					borderColor: "#4a3f20",
					backgroundColor: "#221d10",
					boxShadow: shadow.lg,
					pointerEvents: "auto",
				}}
			>
				<text style={{ color: t.warn, fontSize: font.base, lineClamp: 4 }}>
					{message}
				</text>
				<IconButton glyph="✕" title="dismiss toast" onClick={onDismiss} />
			</Row>
		</div>
	);
}

function NavItem({
	label,
	active,
	onClick,
	badge,
	dotColor,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	badge?: string;
	dotColor?: string;
}) {
	return (
		<div
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				gap: 8,
				paddingLeft: 10,
				paddingRight: 10,
				paddingTop: 7,
				paddingBottom: 7,
				borderRadius: radius.sm,
				backgroundColor: active ? t.bgActive : "transparent",
				cursor: "pointer",
				hover: { backgroundColor: active ? t.bgActive : t.bgHover },
			}}
		>
			{/* The active marker is a bar rather than a colour change alone: at 11px the
          weight difference between an active and an inactive row is easy to miss. */}
			<div
				style={{
					width: 2,
					height: 13,
					flexShrink: 0,
					borderRadius: radius.pill,
					backgroundColor: active ? t.accent : "transparent",
				}}
			/>
			{dotColor ? <Dot color={dotColor} /> : null}
			<text
				style={{
					color: active ? t.text : t.textDim,
					fontSize: font.base,
					fontWeight: active ? 500 : 400,
					lineClamp: 1,
				}}
			>
				{label}
			</text>
			<div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }} />
			{badge ? (
				<text style={{ color: t.textFaint, fontSize: font.xs }}>{badge}</text>
			) : null}
		</div>
	);
}

function Sidebar({
	route,
	state,
	onNavigate,
	replaying,
	port,
	floating,
	onDismiss,
}: {
	route: Route;
	state: AppState;
	onNavigate: (r: Route) => void;
	replaying: boolean;
	port: number;
	/** Drawn over the content as a drawer rather than docked beside it. */
	floating: boolean;
	onDismiss: () => void;
}) {
	return (
		<Col
			gap={0}
			style={{
				width: SIDEBAR_WIDTH,
				flexShrink: 0,
				backgroundColor: t.bgPanel,
				borderRightWidth: 1,
				borderColor: t.border,
				minHeight: 0,
				boxShadow: floating ? shadow.lg : undefined,
			}}
		>
			<Row
				gap={10}
				style={{
					paddingLeft: 14,
					paddingRight: 10,
					paddingTop: 14,
					paddingBottom: 12,
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						width: 28,
						height: 28,
						flexShrink: 0,
						borderRadius: radius.md,
						background: accentGradient,
						boxShadow: shadow.sm,
					}}
				>
					<text style={{ color: t.textOn, fontSize: 14, fontWeight: 700 }}>
						L
					</text>
				</div>
				<Col gap={1} style={{ minWidth: 0, flexGrow: 1 }}>
					<Text size={font.md} weight={600} clamp={1}>
						Layout Agent
					</Text>
					<Text color={t.textFaint} size={font.xs} mono clamp={1}>
						{`localhost:${port}`}
					</Text>
				</Col>
				{floating ? (
					<IconButton glyph="✕" title="close menu" onClick={onDismiss} />
				) : null}
			</Row>

			{replaying ? (
				<div style={{ display: "flex", paddingLeft: 14, paddingBottom: 10 }}>
					<Badge label="replay mode" tone="warn" dot />
				</div>
			) : null}

			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 2,
					overflowY: "scroll",
					flexGrow: 1,
					minHeight: 0,
					paddingLeft: 8,
					paddingRight: 8,
				}}
			>
				<NavItem
					label="Reports"
					active={route.name === "reports" || route.name === "report"}
					onClick={() => onNavigate({ name: "reports" })}
					badge={String(state.reports.length)}
				/>

				<SectionLabel
					style={{ paddingLeft: 14, paddingTop: 14, paddingBottom: 6 }}
				>
					CLIENTS
				</SectionLabel>
				{state.clients.length === 0 ? (
					<Text
						color={t.textFaint}
						size={font.sm}
						style={{ paddingLeft: 14, paddingBottom: 4 }}
					>
						None yet
					</Text>
				) : null}
				{state.clients.map((c) => (
					<NavItem
						key={c.id}
						label={c.name}
						active={route.name === "client" && route.clientId === c.id}
						onClick={() => onNavigate({ name: "client", clientId: c.id })}
						badge={String(
							state.layouts.filter((l) => l.clientId === c.id).length,
						)}
					/>
				))}

				{state.sessions.length > 0 ? (
					<>
						<SectionLabel
							style={{ paddingLeft: 14, paddingTop: 14, paddingBottom: 6 }}
						>
							SESSIONS
						</SectionLabel>
						{state.sessions.map((s) => (
							<NavItem
								key={s.id}
								label={s.providerName}
								active={route.name === "session" && route.sessionId === s.id}
								onClick={() => onNavigate({ name: "session", sessionId: s.id })}
								badge={s.status}
								dotColor={sessionDot(s.status)}
							/>
						))}
					</>
				) : null}

				<div style={{ height: 10 }} />
			</div>

			<Col
				gap={2}
				style={{ padding: 8, borderTopWidth: 1, borderColor: t.border }}
			>
				<NavItem
					label="Settings"
					active={route.name === "settings"}
					onClick={() => onNavigate({ name: "settings" })}
				/>
			</Col>
		</Col>
	);
}

function sessionDot(status: string): string {
	switch (status) {
		case "thinking":
		case "starting":
			return t.accent;
		case "idle":
			return t.ok;
		case "awaiting-permission":
			return t.warn;
		case "error":
			return t.danger;
		default:
			return t.textFaint;
	}
}

type DetailPane = "layouts" | "preview";

function DetailScreen(props: {
	title: string;
	subtitle: string;
	mode: "by-client" | "by-report";
	layouts: AppState["layouts"];
	busyIds: Set<string>;
	queues: AppState["queues"];
	selectedId: string | null;
	pageCount: number;
	renderVersion: number;
	onSelect: (id: string) => void;
	onRender: (id: string) => void;
	onSession: (id: string) => void;
	onDuplicate: (l: AppState["layouts"][number]) => void;
	onEditParams: (l: AppState["layouts"][number]) => void;
	onDelete: (l: AppState["layouts"][number]) => void;
	onAddLayout: () => void;
	onBack: () => void;
}) {
	const b = useBreakpoint();
	const [pane, setPane] = useState<DetailPane>("layouts");
	const selected = props.layouts.find((l) => l.id === props.selectedId) ?? null;
	const queued = props.queues.reduce((n, q) => n + q.depth, 0);

	// Master–detail on one pane: picking a row is the gesture that means "show me this
	// one", so it moves; the switcher is how you get back to the list.
	const select = (id: string) => {
		props.onSelect(id);
		if (b.compact) setPane("preview");
	};

	const showList = !b.compact || pane === "layouts";
	const showPreview = !b.compact || pane === "preview";

	return (
		<Col gap={0} grow={1} style={{ minHeight: 0 }}>
			<PageHeader
				title={props.title}
				subtitle={props.subtitle}
				compact={b.compact}
				leading={
					<IconButton glyph="‹" title="back" onClick={props.onBack} size={28} />
				}
				actions={
					<>
						{queued > 0 ? (
							<Badge label={`${queued} queued`} tone="accent" dot />
						) : null}
						<Button
							label="Add layout"
							icon="+"
							variant="primary"
							onClick={props.onAddLayout}
						/>
					</>
				}
			>
				{b.compact ? (
					<Segmented<DetailPane>
						value={pane}
						grow
						onChange={setPane}
						options={[
							{
								value: "layouts",
								label: "Layouts",
								badge: String(props.layouts.length),
							},
							{ value: "preview", label: "Preview" },
						]}
					/>
				) : null}
			</PageHeader>

			<Row gap={0} grow={1} align="stretch" style={{ minHeight: 0 }}>
				{showList ? (
					<Col
						gap={0}
						grow={1}
						style={{
							minWidth: 0,
							flexBasis: 0,
							borderRightWidth: b.compact ? 0 : 1,
							borderColor: t.border,
						}}
					>
						<LayoutTable
							layouts={props.layouts}
							mode={props.mode}
							compact={b.compact || !b.wide}
							busyIds={props.busyIds}
							selectedId={props.selectedId}
							onSelect={select}
							onRender={props.onRender}
							onSession={props.onSession}
							onDuplicate={props.onDuplicate}
							onEditParams={props.onEditParams}
							onDelete={props.onDelete}
						/>
					</Col>
				) : null}

				{showPreview ? (
					<Col
						gap={0}
						grow={b.compact ? 1 : 1.15}
						style={{ minWidth: 0, flexBasis: 0, backgroundColor: t.bg }}
					>
						{selected ? (
							<>
								<Col
									gap={4}
									style={{
										paddingLeft: 14,
										paddingRight: 14,
										paddingTop: 10,
										paddingBottom: 10,
										borderBottomWidth: 1,
										borderColor: t.border,
										backgroundColor: t.bgPanel,
										flexShrink: 0,
									}}
								>
									<Text size={font.base} weight={600} clamp={1}>
										{`${selected.clientName} · ${selected.reportNumber}`}
									</Text>
									<Text color={t.textFaint} size={font.xs} mono clamp={1}>
										{selected.filePath}
									</Text>
									<Row gap={6}>
										<Dot
											color={statusColor(
												selected.connection?.lastStatus ?? "never",
											)}
										/>
										<Text color={t.textFaint} size={font.xs} clamp={1}>
											{selected.connection
												? connectionLabel(selected.connection)
												: "no connection assigned"}
										</Text>
									</Row>
								</Col>
								<PdfPane
									api={api}
									layoutId={selected.id}
									pageCount={props.pageCount}
									version={props.renderVersion}
									title="Preview"
								/>
							</>
						) : (
							<PreviewPlaceholder b={b} onBack={() => setPane("layouts")} />
						)}
					</Col>
				) : null}
			</Row>
		</Col>
	);
}

function PreviewPlaceholder({
	b,
	onBack,
}: {
	b: Breakpoint;
	onBack: () => void;
}) {
	return (
		<Col
			gap={8}
			style={{
				flexGrow: 1,
				padding: 40,
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<Text color={t.textDim} size={font.md} weight={500}>
				No layout selected
			</Text>
			<Text
				color={t.textFaint}
				size={font.base}
				align="center"
				style={{ maxWidth: 320 }}
			>
				Pick one from the list and its last render appears here.
			</Text>
			{b.compact ? (
				<Button label="Back to layouts" variant="subtle" onClick={onBack} />
			) : null}
		</Col>
	);
}

render(<App />, { title: "Layout Agent", width: 1440, height: 900 });
