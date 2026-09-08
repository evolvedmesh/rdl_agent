/**
 * The shell: sidebar, routes, live socket, toasts, dialogs.
 *
 * Three shapes, chosen by CSS media query rather than by polling the window size:
 * a docked sidebar beside a two-pane screen; a docked sidebar beside a single pane;
 * and — narrowest — an app bar with the sidebar as an overlay drawer.
 */

import type { DetectedProvider } from "@layout/acp";
import type { LayoutDetail } from "@layout/core";
import { AnimatePresence, motion } from "motion/react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	Api,
	type AppState,
	type CredentialStatus,
	type ServerMessage,
} from "./api.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Toast } from "./components/Toast.tsx";
import { Badge, IconButton, Spinner } from "./components/ui.tsx";
import type { DialogKind } from "./screens/dialogs.tsx";
import { Reports } from "./screens/Reports.tsx";
import { applySessionEvent, needsFullRefresh } from "./session-events.ts";

// Only the reports list is needed to paint the first frame. The session view drags in
// the markdown renderer, the sanitiser and the diff view; the dialogs drag in Radix
// Select and the BC parameter fetch. Neither belongs in the boot chunk.
const Session = lazy(() =>
	import("./screens/Session.tsx").then((m) => ({ default: m.Session })),
);
const Settings = lazy(() =>
	import("./screens/Settings.tsx").then((m) => ({ default: m.Settings })),
);
const DetailScreen = lazy(() =>
	import("./screens/DetailScreen.tsx").then((m) => ({
		default: m.DetailScreen,
	})),
);
const AgentPicker = lazy(() =>
	import("./screens/AgentPicker.tsx").then((m) => ({ default: m.AgentPicker })),
);
const Dialog = lazy(() =>
	import("./screens/dialogs.tsx").then((m) => ({ default: m.Dialog })),
);

export type Route =
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

const api = new Api();

export function App() {
	const [route, setRoute] = useState<Route>({ name: "reports" });
	const [state, setState] = useState<AppState>(EMPTY);
	const [ready, setReady] = useState(false);
	const [credentials, setCredentials] = useState<CredentialStatus | null>(null);
	const [providers, setProviders] = useState<DetectedProvider[]>([]);
	const [busy, setBusy] = useState<Set<string>>(new Set());
	const [selectedLayout, setSelectedLayout] = useState<string | null>(null);
	const [renderVersion, setRenderVersion] = useState(0);
	const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
	const [toast, setToast] = useState<string | null>(null);
	const [dialog, setDialog] = useState<DialogKind | null>(null);
	const [navOpen, setNavOpen] = useState(false);
	const [startingProvider, setStartingProvider] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const [s, c] = await Promise.all([api.state(), api.credentials()]);
			setState(s);
			setCredentials(c);
		} catch (e) {
			setToast(e instanceof Error ? e.message : String(e));
		} finally {
			setReady(true);
		}
	}, []);

	useEffect(() => {
		void refresh();
		void api
			.providers()
			.then(setProviders)
			.catch(() => {});

		return api.connect((m: ServerMessage) => {
			if (m.channel === "render") {
				setState((prev) => ({ ...prev, queues: m.queues }));
				const ev = m.event;
				if (ev.type === "queued") {
					setBusy((prev) => new Set(prev).add(ev.layoutId));
				}
				if (ev.type === "finished") {
					setBusy((prev) => {
						const next = new Set(prev);
						next.delete(ev.layoutId);
						return next;
					});
					if (ev.result.ok) {
						setPageCounts((prev) => ({
							...prev,
							[ev.layoutId]: ev.result.pageCount ?? 1,
						}));
						setRenderVersion((v) => v + 1);
					}
					void refresh();
				}
			}

			if (m.channel === "session") {
				// Patch the one session in place. A streamed token must not cost a full
				// /api/state round trip.
				setState((prev) => {
					const i = prev.sessions.findIndex((s) => s.id === m.sessionId);
					if (i === -1) return prev;
					const sessions = [...prev.sessions];
					const existing = sessions[i];
					if (!existing) return prev;
					sessions[i] = applySessionEvent(existing, m.event);
					return { ...prev, sessions };
				});
				if (needsFullRefresh(m.event)) {
					setRenderVersion((v) => v + 1);
					void refresh();
				}
				if (m.event.type === "error") setToast(m.event.message);
			}
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

	return (
		<div className="relative flex h-full w-full overflow-hidden bg-canvas">
			{/* Docked at compact and up; the drawer below handles narrow. */}
			<div className="hidden compact:flex">
				<Sidebar
					route={route}
					state={state}
					onNavigate={navigate}
					origin={api.base}
				/>
			</div>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<div className="compact:hidden">
					<AppBar onMenu={() => setNavOpen((v) => !v)} />
				</div>

				{!ready ? (
					<BootSkeleton />
				) : (
					<Suspense fallback={<ScreenLoading />}>
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
								api={api}
								title={detailTitle}
								subtitle={
									route.name === "report"
										? `${layoutsFor.length} client layout${layoutsFor.length === 1 ? "" : "s"}`
										: `${layoutsFor.length} report${layoutsFor.length === 1 ? "" : "s"}`
								}
								mode={route.name === "report" ? "by-client" : "by-report"}
								layouts={layoutsFor}
								busyIds={busy}
								selectedId={selectedLayout}
								onSelect={setSelectedLayout}
								onRender={doRender}
								onSession={(layoutId) => navigate({ name: "agent", layoutId })}
								onBack={() => navigate({ name: "reports" })}
								pageCount={selected ? (pageCounts[selected.id] ?? 1) : 1}
								renderVersion={renderVersion}
								onDuplicate={(l: LayoutDetail) =>
									setDialog({ kind: "duplicate", layout: l })
								}
								onEditParams={(l: LayoutDetail) =>
									setDialog({ kind: "edit-params", layout: l })
								}
								onDelete={(l: LayoutDetail) =>
									setDialog({ kind: "delete-layout", layout: l })
								}
								onAddLayout={() =>
									setDialog({
										kind: "add-layout",
										reportId:
											route.name === "report" ? route.reportId : undefined,
									})
								}
							/>
						)}
					</Suspense>
				)}
			</div>

			<AnimatePresence>
				{navOpen ? (
					<motion.div
						key="drawer"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.15 }}
						onClick={() => setNavOpen(false)}
						className="absolute inset-0 z-40 flex bg-black/70 compact:hidden"
					>
						<motion.div
							initial={{ x: -40 }}
							animate={{ x: 0 }}
							exit={{ x: -40 }}
							transition={{ duration: 0.18, ease: "easeOut" }}
							onClick={(e) => e.stopPropagation()}
							className="shadow-float"
						>
							<Sidebar
								route={route}
								state={state}
								onNavigate={navigate}
								origin={api.base}
								onDismiss={() => setNavOpen(false)}
							/>
						</motion.div>
					</motion.div>
				) : null}
			</AnimatePresence>

			<Toast message={toast} onDismiss={() => setToast(null)} />

			{dialog ? (
				<Suspense fallback={null}>
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
				</Suspense>
			) : null}
		</div>
	);
}

/** While a lazily-loaded screen's chunk arrives. Off loopback that is a few ms. */
function ScreenLoading() {
	return (
		<div className="flex flex-1 items-center justify-center">
			<Spinner className="text-faint" />
		</div>
	);
}

/** The narrow-window title strip. The only place the drawer toggle lives. */
function AppBar({ onMenu }: { onMenu: () => void }) {
	return (
		<header className="flex shrink-0 items-center gap-2.5 border-b border-subtle bg-panel px-3 py-2">
			<IconButton label="menu" onClick={onMenu}>
				<svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
					<path
						d="M2 4h12M2 8h12M2 12h12"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			</IconButton>
			<span className="text-base font-semibold">Layout Agent</span>
			<span className="flex-1" />
			{window.location.search.includes("replay") ? (
				<Badge tone="warn">replay</Badge>
			) : null}
		</header>
	);
}

/** The gap between the window opening and the core answering /api/state. */
function BootSkeleton() {
	return (
		<div className="flex flex-1 flex-col gap-4 p-6">
			<div className="h-7 w-52 animate-pulse rounded-md bg-raised/70" />
			<div className="grid grid-cols-2 gap-3 wide:grid-cols-4">
				{[0, 1, 2, 3].map((i) => (
					<div
						key={i}
						className="h-16 animate-pulse rounded-md bg-raised/50"
						style={{ animationDelay: `${i * 70}ms` }}
					/>
				))}
			</div>
			<div className="grid gap-3 md:grid-cols-2 wide:grid-cols-3">
				{[0, 1, 2, 3, 4, 5].map((i) => (
					<div
						key={i}
						className="h-28 animate-pulse rounded-lg bg-raised/40"
						style={{ animationDelay: `${i * 60}ms` }}
					/>
				))}
			</div>
		</div>
	);
}
