import type { Route } from "../App.tsx";
import type { AppState } from "../api.ts";
import type { statusTone } from "../theme.ts";
import { Badge, cx, Dot, IconButton, PulseDot, SectionLabel } from "./ui.tsx";

const sessionTone = (status: string) =>
	status === "thinking"
		? "accent"
		: status === "awaiting-permission"
			? "warn"
			: status === "error"
				? "danger"
				: status === "idle"
					? "ok"
					: "neutral";

export function Sidebar({
	route,
	state,
	onNavigate,
	origin,
	onDismiss,
}: {
	route: Route;
	state: AppState;
	onNavigate: (r: Route) => void;
	origin: string;
	/** Present only when drawn as an overlay drawer. */
	onDismiss?: () => void;
}) {
	return (
		<nav className="flex h-full w-61 shrink-0 flex-col border-r border-subtle bg-panel">
			<div className="flex items-center gap-2.5 px-3.5 pt-3.5 pb-3">
				<div className="accent-fill flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-bold text-on shadow-raise">
					L
				</div>
				<div className="min-w-0 flex-1">
					<div className="truncate text-base font-semibold">Layout Agent</div>
					<div className="truncate font-mono text-xs text-faint">
						{origin.replace(/^https?:\/\//, "")}
					</div>
				</div>
				{onDismiss ? (
					<IconButton label="close menu" onClick={onDismiss}>
						<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
							<path
								d="M4 4l8 8M12 4l-8 8"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</IconButton>
				) : null}
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
				<NavItem
					label="Reports"
					active={route.name === "reports" || route.name === "report"}
					onClick={() => onNavigate({ name: "reports" })}
					badge={String(state.reports.length)}
				/>

				<div className="px-3.5 pt-3.5 pb-1.5">
					<SectionLabel>Clients</SectionLabel>
				</div>
				{state.clients.length === 0 ? (
					<div className="px-3.5 pb-1 text-sm text-faint">None yet</div>
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
						<div className="px-3.5 pt-3.5 pb-1.5">
							<SectionLabel>Sessions</SectionLabel>
						</div>
						{state.sessions.map((s) => (
							<NavItem
								key={s.id}
								label={s.providerName}
								active={route.name === "session" && route.sessionId === s.id}
								onClick={() => onNavigate({ name: "session", sessionId: s.id })}
								badge={s.status}
								live={s.status === "thinking"}
								tone={sessionTone(s.status)}
							/>
						))}
					</>
				) : null}
			</div>

			<div className="border-t border-subtle p-2">
				<NavItem
					label="Settings"
					active={route.name === "settings"}
					onClick={() => onNavigate({ name: "settings" })}
				/>
			</div>
		</nav>
	);
}

function NavItem({
	label,
	active,
	onClick,
	badge,
	tone,
	live,
}: {
	label: string;
	active: boolean;
	onClick: () => void;
	badge?: string;
	tone?: ReturnType<typeof statusTone>;
	live?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cx(
				"group flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left",
				"transition-colors duration-150",
				active ? "bg-active text-fg" : "text-dim hover:bg-hover hover:text-fg",
			)}
		>
			{/* A bar, not just a colour change: at this size the weight difference
			    between an active and inactive row is easy to miss. */}
			<span
				className={cx(
					"h-3.5 w-0.5 shrink-0 rounded-full transition-colors",
					active ? "bg-accent" : "bg-transparent",
				)}
			/>
			{tone ? live ? <PulseDot tone={tone} /> : <Dot tone={tone} /> : null}
			<span
				className={cx(
					"min-w-0 flex-1 truncate text-base",
					active && "font-medium",
				)}
			>
				{label}
			</span>
			{badge ? (
				<span className="shrink-0 text-xs text-faint tabular-nums">
					{badge}
				</span>
			) : null}
		</button>
	);
}

export { Badge };
