/**
 * The primitive set.
 *
 * Most of what the GPUIX version of this file existed to work around is gone: the
 * browser inherits colour, wraps text, clips with ellipsis, and has media queries, so
 * the explicit `color` on every node, the `minWidth: 0` guards and the `useBreakpoint()`
 * polling all disappear. What is left is the visual vocabulary.
 */

import type { ComponentProps, ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]): string =>
	parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ text --- */

export function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="text-2xs font-semibold uppercase tracking-[0.09em] text-faint">
			{children}
		</div>
	);
}

export function Muted({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return <span className={cx("text-dim", className)}>{children}</span>;
}

/* ---------------------------------------------------------------- button --- */

type ButtonVariant = "primary" | "default" | "subtle" | "danger" | "ghost";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
	primary: "accent-fill text-on border-transparent shadow-raise",
	default: "bg-raised text-fg border-strong hover:bg-hover",
	subtle: "bg-panel text-dim border-subtle hover:bg-raised hover:text-fg",
	danger: "bg-danger-soft text-danger border-danger-line hover:bg-[#3a1c1f]",
	ghost:
		"bg-transparent text-dim border-transparent hover:bg-raised hover:text-fg",
};

export function Button({
	variant = "default",
	size = "md",
	className,
	children,
	...rest
}: ComponentProps<"button"> & {
	variant?: ButtonVariant;
	size?: "sm" | "md";
}) {
	return (
		<button
			type="button"
			{...rest}
			className={cx(
				"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium",
				"transition-all duration-150 ease-out active:scale-[0.97]",
				"disabled:pointer-events-none disabled:opacity-45",
				size === "sm" ? "h-6.5 px-2 text-xs" : "h-8 px-3 text-sm",
				BUTTON_VARIANT[variant],
				className,
			)}
		>
			{children}
		</button>
	);
}

export function IconButton({
	label,
	className,
	children,
	...rest
}: ComponentProps<"button"> & { label: string }) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			{...rest}
			className={cx(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-md",
				"text-dim transition-colors duration-150 hover:bg-raised hover:text-fg",
				"disabled:pointer-events-none disabled:opacity-40",
				className,
			)}
		>
			{children}
		</button>
	);
}

/* ----------------------------------------------------------------- badge --- */

import { type Tone, toneClass } from "../theme.ts";

export function Badge({
	tone = "neutral",
	children,
	className,
	title,
}: {
	tone?: Tone;
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cx(
				"inline-flex max-w-full shrink-0 items-center gap-1 self-start rounded-full border",
				"px-2 py-0.5 text-2xs font-medium whitespace-nowrap",
				toneClass(tone),
				className,
			)}
		>
			{children}
		</span>
	);
}

export function Dot({ tone = "neutral" }: { tone?: Tone }) {
	const color =
		tone === "ok"
			? "bg-ok"
			: tone === "warn"
				? "bg-warn"
				: tone === "danger"
					? "bg-danger"
					: tone === "accent"
						? "bg-accent"
						: tone === "info"
							? "bg-info"
							: "bg-faint";
	return <span className={cx("size-1.5 shrink-0 rounded-full", color)} />;
}

/** A dot that breathes, for work actually in flight. */
export function PulseDot({ tone = "accent" }: { tone?: Tone }) {
	return (
		<span className="relative flex size-1.5 shrink-0">
			<span
				className={cx(
					"absolute inline-flex size-full animate-ping rounded-full opacity-70",
					tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-accent",
				)}
			/>
			<Dot tone={tone} />
		</span>
	);
}

/* --------------------------------------------------------------- surface --- */

export function Card({
	className,
	children,
	interactive,
	...rest
}: ComponentProps<"div"> & { interactive?: boolean }) {
	return (
		<div
			{...rest}
			className={cx(
				"rounded-lg border border-subtle bg-panel",
				interactive &&
					"cursor-pointer transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-strong hover:bg-raised hover:shadow-pop",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function Well({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			className={cx(
				"rounded-md border border-subtle bg-sunken p-2.5 font-mono text-xs text-dim",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function Rule({ className }: { className?: string }) {
	return <div className={cx("h-px w-full bg-subtle", className)} />;
}

export function PageHeader({
	title,
	subtitle,
	actions,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="flex flex-wrap items-end justify-between gap-3 pb-1">
			<div className="min-w-0">
				<h1 className="truncate text-xl font-semibold tracking-tight text-fg">
					{title}
				</h1>
				{subtitle ? (
					<p className="mt-0.5 truncate text-xs text-dim">{subtitle}</p>
				) : null}
			</div>
			{actions ? (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			) : null}
		</header>
	);
}

export function Stat({
	label,
	value,
	tone = "neutral",
}: {
	label: string;
	value: ReactNode;
	tone?: Tone;
}) {
	const fg =
		tone === "ok"
			? "text-ok"
			: tone === "danger"
				? "text-danger"
				: tone === "warn"
					? "text-warn"
					: "text-fg";
	return (
		<div className="rounded-md border border-subtle bg-panel px-3 py-2">
			<div className="text-2xs uppercase tracking-wide text-faint">{label}</div>
			<div className={cx("mt-0.5 text-lg font-semibold tabular-nums", fg)}>
				{value}
			</div>
		</div>
	);
}

export function Empty({
	title,
	hint,
	action,
}: {
	title: string;
	hint?: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-subtle px-6 py-12 text-center">
			<div className="text-base font-medium text-dim">{title}</div>
			{hint ? <div className="max-w-md text-xs text-faint">{hint}</div> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	);
}

/* -------------------------------------------------------------- controls --- */

export function Segmented<T extends string>({
	value,
	options,
	onChange,
	className,
}: {
	value: T;
	options: { value: T; label: ReactNode }[];
	onChange: (v: T) => void;
	className?: string;
}) {
	return (
		<div
			className={cx(
				"inline-flex shrink-0 items-center gap-0.5 rounded-md border border-subtle bg-panel p-0.5",
				className,
			)}
		>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => onChange(o.value)}
					aria-pressed={o.value === value}
					className={cx(
						"rounded-sm px-2.5 py-1 text-xs font-medium transition-colors duration-150",
						o.value === value ? "bg-active text-fg" : "text-dim hover:text-fg",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

export function Field({
	label,
	hint,
	error,
	children,
}: {
	label: string;
	hint?: ReactNode;
	error?: string | null;
	children: ReactNode;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium text-dim">{label}</span>
			{children}
			{error ? (
				<span className="text-xs text-danger">{error}</span>
			) : hint ? (
				<span className="text-xs text-faint">{hint}</span>
			) : null}
		</label>
	);
}

const INPUT_CLASS =
	"w-full rounded-md border border-subtle bg-sunken px-2.5 py-1.5 text-sm text-fg " +
	"placeholder:text-faint transition-colors duration-150 " +
	"hover:border-strong focus:border-focus focus:outline-none " +
	"disabled:opacity-50";

export function Input({ className, ...rest }: ComponentProps<"input">) {
	return <input {...rest} className={cx(INPUT_CLASS, className)} />;
}

export function TextArea({ className, ...rest }: ComponentProps<"textarea">) {
	return (
		<textarea
			{...rest}
			className={cx(INPUT_CLASS, "resize-y font-mono text-xs", className)}
		/>
	);
}

/** A skeleton block, for the gap between opening the window and the core answering. */
export function Skeleton({ className }: { className?: string }) {
	return (
		<div
			className={cx(
				"animate-pulse rounded-md bg-raised/70",
				className ?? "h-4 w-full",
			)}
		/>
	);
}

export function Spinner({ className }: { className?: string }) {
	return (
		<span
			className={cx(
				"inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
				className,
			)}
		/>
	);
}
