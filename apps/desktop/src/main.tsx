/**
 * The desktop shell.
 *
 * GPUIX runs GPUI's native event loop on a dedicated Rust UI thread on Linux and
 * Windows, so Bun's event loop stays free — which is why the core process (HTTP server,
 * WebSocket, render engine, ACP subprocesses, MCP server) can live in this same process
 * rather than being spawned as a sidecar. The UI still talks to it over localhost, so
 * nothing here is load-bearing for the core: a browser can drive the same server.
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
import { Badge, Button, Col, Row, Text } from "./components/ui.tsx";
import { AgentPicker } from "./screens/AgentPicker.tsx";
import { Dialog, type DialogKind } from "./screens/dialogs.tsx";
import { LayoutTable } from "./screens/LayoutTable.tsx";
import { Reports } from "./screens/Reports.tsx";
import { Session } from "./screens/Session.tsx";
import { Settings } from "./screens/Settings.tsx";
import { t } from "./theme.ts";

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

function App() {
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

	return (
		// `position: relative` so the modal overlay can be absolutely positioned over the
		// whole app: GPUIX is single-window with no portal to escape to.
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				height: "100%",
				backgroundColor: t.bg,
				position: "relative",
			}}
		>
			<Sidebar
				route={route}
				state={state}
				onNavigate={setRoute}
				replaying={core.replaying}
				port={core.server.port ?? 0}
			/>

			<Col gap={0} grow={1} style={{ minWidth: 0, minHeight: 0 }}>
				{toast ? (
					<Row
						style={{
							paddingLeft: 16,
							paddingRight: 16,
							paddingTop: 8,
							paddingBottom: 8,
							backgroundColor: "#2a2416",
							borderBottomWidth: 1,
							borderColor: "#4a3f20",
						}}
					>
						<text style={{ color: t.warn, fontSize: 12 }}>{toast}</text>
						<div style={{ flexGrow: 1 }} />
						<Button
							label="Dismiss"
							variant="ghost"
							onClick={() => setToast(null)}
						/>
					</Row>
				) : null}

				{activeSession ? (
					<Session
						api={api}
						session={activeSession}
						queues={state.queues}
						pageCount={pageCounts[activeSession.layoutId] ?? 1}
						renderVersion={renderVersion}
						layoutTitle={layoutTitleFor(activeSession.layoutId)}
						onClose={() => setRoute({ name: "reports" })}
					/>
				) : route.name === "agent" ? (
					<AgentPicker
						layoutTitle={layoutTitleFor(route.layoutId)}
						providers={providers}
						starting={startingProvider}
						onStart={(providerId) =>
							void startSessionWithProvider(route.layoutId, providerId)
						}
						onBack={() => setRoute({ name: "reports" })}
					/>
				) : route.name === "reports" ? (
					<Reports
						reports={state.reports}
						stats={state.stats}
						onOpen={(reportId) => setRoute({ name: "report", reportId })}
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
						onSession={(layoutId) => setRoute({ name: "agent", layoutId })}
						onBack={() => setRoute({ name: "reports" })}
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

function Sidebar({
	route,
	state,
	onNavigate,
	replaying,
	port,
}: {
	route: Route;
	state: AppState;
	onNavigate: (r: Route) => void;
	replaying: boolean;
	port: number;
}) {
	const item = (
		label: string,
		active: boolean,
		onClick: () => void,
		badge?: string,
	) => (
		<div
			key={label}
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				gap: 8,
				paddingLeft: 12,
				paddingRight: 12,
				paddingTop: 7,
				paddingBottom: 7,
				borderRadius: 6,
				backgroundColor: active ? t.bgActive : "transparent",
				cursor: "pointer",
				hover: { backgroundColor: active ? t.bgActive : t.bgHover },
			}}
		>
			<text style={{ color: active ? t.text : t.textDim, fontSize: 12.5 }}>
				{label}
			</text>
			<div style={{ flexGrow: 1 }} />
			{badge ? (
				<text style={{ color: t.textFaint, fontSize: 11 }}>{badge}</text>
			) : null}
		</div>
	);

	return (
		<Col
			gap={0}
			style={{
				width: 232,
				backgroundColor: t.bgPanel,
				borderRightWidth: 1,
				borderColor: t.border,
				minHeight: 0,
			}}
		>
			<Col gap={2} style={{ padding: 14 }}>
				<Text size={14} weight={600}>
					Layout Agent
				</Text>
				<Text color={t.textFaint} size={11} mono>
					{`localhost:${port}`}
				</Text>
				{replaying ? <Badge label="replay mode" color={t.warn} /> : null}
			</Col>

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
				{item(
					"Reports",
					route.name === "reports" || route.name === "report",
					() => onNavigate({ name: "reports" }),
					String(state.reports.length),
				)}

				<div style={{ height: 10 }} />
				<Text
					color={t.textFaint}
					size={10.5}
					style={{ paddingLeft: 12, paddingBottom: 4 }}
				>
					CLIENTS
				</Text>
				{state.clients.map((c) =>
					item(
						c.name,
						route.name === "client" && route.clientId === c.id,
						() => onNavigate({ name: "client", clientId: c.id }),
						String(state.layouts.filter((l) => l.clientId === c.id).length),
					),
				)}

				{state.sessions.length > 0 ? (
					<>
						<div style={{ height: 10 }} />
						<Text
							color={t.textFaint}
							size={10.5}
							style={{ paddingLeft: 12, paddingBottom: 4 }}
						>
							SESSIONS
						</Text>
						{state.sessions.map((s) =>
							item(
								`${s.providerName} · ${s.status}`,
								route.name === "session" && route.sessionId === s.id,
								() => onNavigate({ name: "session", sessionId: s.id }),
							),
						)}
					</>
				) : null}
			</div>

			<Col
				gap={2}
				style={{ padding: 8, borderTopWidth: 1, borderColor: t.border }}
			>
				{item("Settings", route.name === "settings", () =>
					onNavigate({ name: "settings" }),
				)}
			</Col>
		</Col>
	);
}

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
	const selected = props.layouts.find((l) => l.id === props.selectedId) ?? null;
	const queued = props.queues.reduce((n, q) => n + q.depth, 0);

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
				<Button label="‹" variant="ghost" onClick={props.onBack} />
				<Col gap={2} style={{ minWidth: 0 }}>
					<Text size={16} weight={600} clamp={1}>
						{props.title}
					</Text>
					<Text color={t.textFaint} size={12}>
						{props.subtitle}
					</Text>
				</Col>
				<div style={{ flexGrow: 1 }} />
				{queued > 0 ? (
					<Badge
						label={`${queued} render${queued === 1 ? "" : "s"} queued`}
						color={t.accent}
					/>
				) : null}
				<Button label="Add layout" onClick={props.onAddLayout} />
			</Row>

			<Row gap={0} grow={1} align="stretch" style={{ minHeight: 0 }}>
				<Col
					gap={0}
					grow={1}
					style={{ minWidth: 520, borderRightWidth: 1, borderColor: t.border }}
				>
					<LayoutTable
						layouts={props.layouts}
						mode={props.mode}
						busyIds={props.busyIds}
						selectedId={props.selectedId}
						onSelect={props.onSelect}
						onRender={props.onRender}
						onSession={props.onSession}
						onDuplicate={props.onDuplicate}
						onEditParams={props.onEditParams}
						onDelete={props.onDelete}
					/>
				</Col>

				<Col gap={0} grow={1} style={{ minWidth: 380 }}>
					{selected ? (
						<>
							<Col
								gap={4}
								style={{
									padding: 12,
									borderBottomWidth: 1,
									borderColor: t.border,
									backgroundColor: t.bgPanel,
								}}
							>
								<Text size={12.5} weight={500} clamp={1}>
									{`${selected.clientName} · ${selected.reportNumber}`}
								</Text>
								<Text color={t.textFaint} size={11} mono clamp={1}>
									{selected.filePath}
								</Text>
								<Text color={t.textFaint} size={11}>
									{selected.connection
										? connectionLabel(selected.connection)
										: "no connection assigned"}
								</Text>
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
						<Col gap={6} style={{ padding: 32, alignItems: "center" }}>
							<Text color={t.textDim}>Select a layout</Text>
							<Text color={t.textFaint} size={12}>
								Its last render appears here.
							</Text>
						</Col>
					)}
				</Col>
			</Row>
		</Col>
	);
}

render(<App />, { title: "Layout Agent", width: 1440, height: 900 });
