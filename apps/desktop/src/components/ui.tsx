/**
 * Shared primitives.
 *
 * Five GPUIX rules are enforced here so screens do not have to remember them:
 *   - every <text> carries an explicit `color`; GPUI does not inherit it, and an
 *     uncoloured run paints black and vanishes on a dark surface
 *   - `div` is block by default, so any row or column sets `display: "flex"`
 *   - there is no multi-value shorthand for padding/margin/border
 *   - a <text> takes exactly ONE string child. Several children become separate runs
 *     that wrap between each other, so `{n} items` renders as two stacked lines —
 *     always interpolate into one template literal instead
 *   - a flex child stretches to fill its cross axis, so anything that must hug its
 *     content sets `alignSelf: "flex-start"`
 *
 * Responsiveness lives in `useBreakpoint`. GPUI has no media queries, so every screen
 * that changes shape reads the window size and branches on it.
 */
import { useWindowSize } from "@gpuix/react";
import type { ReactNode } from "react";
import { bp, font, radius, shadow, type Tone, t, tone } from "../theme.ts";
import { handleWordEdit } from "./textedit.ts";

export type Breakpoint = {
	width: number;
	height: number;
	/** Two-pane splits collapse to one pane plus a switcher. */
	compact: boolean;
	/** The sidebar is an overlay rather than a docked column. */
	narrow: boolean;
	/** Room for generous gutters and a wider chat pane. */
	wide: boolean;
};

/**
 * The window size, bucketed. `useWindowSize` polls at 100ms, so this updates while a
 * window is being dragged rather than only on mouse-up.
 */
export function useBreakpoint(): Breakpoint {
	const { width, height } = useWindowSize();
	return {
		width,
		height,
		compact: width < bp.compact,
		narrow: width < bp.narrow,
		wide: width >= 1600,
	};
}

/** Padding that grows with the window, so a wide screen is not all gutter or all edge. */
export function gutter(b: Breakpoint): number {
	return b.narrow ? 14 : b.compact ? 18 : 24;
}

export function Row({
	children,
	gap = 8,
	align = "center",
	justify,
	grow,
	shrink,
	wrap,
	style,
}: {
	children?: ReactNode;
	gap?: number;
	align?: string;
	justify?: string;
	grow?: number;
	shrink?: number;
	wrap?: boolean;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: align,
				justifyContent: justify,
				flexWrap: wrap ? "wrap" : undefined,
				gap,
				flexGrow: grow,
				flexShrink: shrink,
				...style,
			}}
		>
			{children}
		</div>
	);
}

export function Col({
	children,
	gap = 8,
	align,
	justify,
	grow,
	shrink,
	style,
}: {
	children?: ReactNode;
	gap?: number;
	align?: string;
	justify?: string;
	grow?: number;
	shrink?: number;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: align,
				justifyContent: justify,
				gap,
				flexGrow: grow,
				flexShrink: shrink,
				...style,
			}}
		>
			{children}
		</div>
	);
}

/** Pushes whatever follows it to the far end of a Row or Col. */
export function Spacer() {
	return <div style={{ flexGrow: 1, flexBasis: 0, minWidth: 0 }} />;
}

export function Text({
	children,
	color = t.text,
	size = font.base,
	weight,
	mono,
	clamp,
	ellipsis,
	align,
	lineHeight,
	style,
}: {
	children?: ReactNode;
	color?: string;
	size?: number;
	weight?: number | string;
	mono?: boolean;
	clamp?: number;
	/** One line, truncated with an ellipsis rather than wrapped. */
	ellipsis?: boolean;
	align?: string;
	lineHeight?: number;
	style?: Record<string, unknown>;
}) {
	return (
		<text
			style={{
				color,
				fontSize: size,
				fontWeight: weight,
				fontFamily: mono ? t.mono : undefined,
				lineClamp: clamp,
				whiteSpace: ellipsis ? "nowrap" : undefined,
				textOverflow: ellipsis ? "ellipsis" : undefined,
				textAlign: align,
				lineHeight,
				...style,
			}}
		>
			{children}
		</text>
	);
}

/** A small all-caps label above a group. */
export function SectionLabel({
	children,
	style,
}: {
	children?: ReactNode;
	style?: Record<string, unknown>;
}) {
	return (
		<text
			style={{
				color: t.textFaint,
				fontSize: font.xs,
				fontWeight: 600,
				...style,
			}}
		>
			{children}
		</text>
	);
}

export type ButtonVariant =
	| "default"
	| "primary"
	| "danger"
	| "ghost"
	| "subtle";

export function Button({
	label,
	icon,
	onClick,
	variant = "default",
	size = "md",
	disabled,
	grow,
	testId,
	style,
}: {
	label: string;
	/** A leading glyph. Rendered as its own run so it keeps its own colour. */
	icon?: string;
	onClick?: () => void;
	variant?: ButtonVariant;
	size?: "sm" | "md";
	disabled?: boolean;
	grow?: boolean;
	testId?: string;
	style?: Record<string, unknown>;
}) {
	const sm = size === "sm";
	const base: Record<string, unknown> =
		variant === "primary"
			? {
					background: t.accentDim,
					borderColor: "#5b83d8",
					boxShadow: shadow.sm,
				}
			: variant === "danger"
				? { backgroundColor: t.dangerSoft, borderColor: "#5c2f33" }
				: variant === "ghost"
					? { backgroundColor: "transparent", borderColor: "transparent" }
					: variant === "subtle"
						? { backgroundColor: t.bgPanel, borderColor: t.border }
						: {
								backgroundColor: t.bgRaised,
								borderColor: t.borderStrong,
								boxShadow: shadow.sm,
							};

	const fg =
		variant === "primary"
			? t.textOn
			: variant === "danger"
				? t.danger
				: variant === "ghost"
					? t.textDim
					: t.text;

	const hover: Record<string, unknown> =
		variant === "primary"
			? { backgroundColor: "#4a72c6" }
			: variant === "danger"
				? { backgroundColor: "#3a1f22" }
				: { backgroundColor: t.bgHover, borderColor: t.borderStrong };

	return (
		<div
			testId={testId}
			onClick={disabled ? undefined : onClick}
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				justifyContent: "center",
				gap: 6,
				flexGrow: grow ? 1 : 0,
				flexShrink: 0,
				paddingLeft: sm ? 9 : 12,
				paddingRight: sm ? 9 : 12,
				paddingTop: sm ? 4 : 6,
				paddingBottom: sm ? 4 : 6,
				borderRadius: radius.sm,
				borderWidth: 1,
				opacity: disabled ? 0.42 : 1,
				cursor: disabled ? "default" : "pointer",
				...base,
				hover: disabled ? {} : hover,
				active: disabled ? {} : { backgroundColor: t.bgActive },
				...style,
			}}
		>
			{icon ? (
				<text
					style={{ color: fg, fontSize: sm ? 11 : 12, opacity: 0.85 }}
				>{`${icon}`}</text>
			) : null}
			<text
				style={{
					color: fg,
					fontSize: sm ? font.sm : font.base,
					fontWeight: 500,
					whiteSpace: "nowrap",
				}}
			>
				{label}
			</text>
		</div>
	);
}

/** A square glyph button — toolbar chrome that should not spend width on a word. */
export function IconButton({
	glyph,
	onClick,
	title,
	active,
	disabled,
	size = 26,
}: {
	glyph: string;
	onClick?: () => void;
	title?: string;
	active?: boolean;
	disabled?: boolean;
	size?: number;
}) {
	return (
		<div
			testId={title}
			onClick={disabled ? undefined : onClick}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: size,
				height: size,
				flexShrink: 0,
				borderRadius: radius.sm,
				backgroundColor: active ? t.bgActive : "transparent",
				opacity: disabled ? 0.4 : 1,
				cursor: disabled ? "default" : "pointer",
				hover: disabled ? {} : { backgroundColor: t.bgHover },
			}}
		>
			<text
				style={{
					color: active ? t.text : t.textDim,
					fontSize: 13,
				}}
			>
				{glyph}
			</text>
		</div>
	);
}

/**
 * A soft-filled pill. The tinted fill is what lets a badge read at a glance in a dense
 * row; an outline-only badge disappears against a bordered surface.
 */
export function Badge({
	label,
	tone: name = "neutral",
	color,
	dot,
}: {
	label: string;
	tone?: Tone;
	/** An explicit foreground, when the colour comes from data rather than a tone. */
	color?: string;
	dot?: boolean;
}) {
	const c = tone(name);
	const fg = color ?? c.fg;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				alignItems: "center",
				gap: 5,
				// A flex child stretches to fill its cross axis; a badge must hug its label.
				alignSelf: "flex-start",
				flexGrow: 0,
				flexShrink: 0,
				paddingLeft: dot ? 6 : 7,
				paddingRight: 7,
				paddingTop: 2,
				paddingBottom: 2,
				borderRadius: radius.pill,
				borderWidth: 1,
				borderColor: c.border,
				backgroundColor: c.bg,
			}}
		>
			{dot ? (
				<div
					style={{
						width: 5,
						height: 5,
						flexShrink: 0,
						borderRadius: radius.pill,
						backgroundColor: fg,
					}}
				/>
			) : null}
			<text
				style={{
					color: fg,
					fontSize: font.xs,
					fontWeight: 500,
					whiteSpace: "nowrap",
				}}
			>
				{label}
			</text>
		</div>
	);
}

/** A bare status dot, for rows too dense for a whole badge. */
export function Dot({ color, size = 6 }: { color: string; size?: number }) {
	return (
		<div
			style={{
				width: size,
				height: size,
				flexShrink: 0,
				alignSelf: "center",
				borderRadius: radius.pill,
				backgroundColor: color,
			}}
		/>
	);
}

export function Card({
	children,
	onClick,
	padding = 16,
	gap = 10,
	selected,
	style,
}: {
	children?: ReactNode;
	onClick?: () => void;
	padding?: number;
	gap?: number;
	selected?: boolean;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "column",
				gap,
				padding,
				borderRadius: radius.lg,
				borderWidth: 1,
				borderColor: selected ? t.accentDim : t.border,
				backgroundColor: selected ? t.bgRaised : t.bgPanel,
				boxShadow: shadow.sm,
				cursor: onClick ? "pointer" : undefined,
				hover: onClick
					? { backgroundColor: t.bgRaised, borderColor: t.borderStrong }
					: {},
				...style,
			}}
		>
			{children}
		</div>
	);
}

/**
 * The standard screen header: a title block on the left, actions on the right, and a
 * hairline under it. Every screen uses this one so the app has a single top edge rather
 * than five slightly different ones.
 */
export function PageHeader({
	title,
	subtitle,
	leading,
	actions,
	compact,
	children,
}: {
	title: string;
	subtitle?: string;
	/** A back button or menu toggle, placed before the title. */
	leading?: ReactNode;
	actions?: ReactNode;
	/** Wraps the actions onto their own line when the window is narrow. */
	compact?: boolean;
	/** An extra strip below the title row — a switcher, a filter bar. */
	children?: ReactNode;
}) {
	return (
		<Col
			gap={compact ? 10 : 0}
			style={{
				paddingLeft: compact ? 14 : 20,
				paddingRight: compact ? 14 : 20,
				paddingTop: 12,
				paddingBottom: 12,
				borderBottomWidth: 1,
				borderColor: t.border,
				backgroundColor: t.bgPanel,
				flexShrink: 0,
			}}
		>
			<Row gap={10} wrap={compact}>
				{leading}
				<Col gap={2} style={{ minWidth: 0, flexGrow: 1, flexShrink: 1 }}>
					<Text size={compact ? font.lg : font.xl} weight={600} clamp={1}>
						{title}
					</Text>
					{subtitle ? (
						<Text color={t.textFaint} size={font.sm} clamp={1}>
							{subtitle}
						</Text>
					) : null}
				</Col>
				{actions ? (
					<Row gap={8} style={{ flexShrink: 0 }}>
						{actions}
					</Row>
				) : null}
			</Row>
			{children}
		</Col>
	);
}

/** A horizontal switcher. The only navigation available once a split collapses. */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	grow,
}: {
	value: T;
	options: { value: T; label: string; badge?: string }[];
	onChange: (v: T) => void;
	grow?: boolean;
}) {
	return (
		<Row
			gap={2}
			style={{
				alignSelf: grow ? "stretch" : "flex-start",
				padding: 2,
				borderRadius: radius.md,
				borderWidth: 1,
				borderColor: t.border,
				backgroundColor: t.bgSunken,
			}}
		>
			{options.map((o) => {
				const on = o.value === value;
				return (
					<div
						key={o.value}
						onClick={() => onChange(o.value)}
						style={{
							display: "flex",
							flexDirection: "row",
							alignItems: "center",
							justifyContent: "center",
							gap: 6,
							flexGrow: grow ? 1 : 0,
							paddingLeft: 12,
							paddingRight: 12,
							paddingTop: 5,
							paddingBottom: 5,
							borderRadius: radius.sm,
							backgroundColor: on ? t.bgRaised : "transparent",
							cursor: "pointer",
							hover: on ? {} : { backgroundColor: t.bgHover },
						}}
					>
						<text
							style={{
								color: on ? t.text : t.textDim,
								fontSize: font.base,
								fontWeight: on ? 500 : 400,
								whiteSpace: "nowrap",
							}}
						>
							{o.label}
						</text>
						{o.badge ? (
							<text style={{ color: t.textFaint, fontSize: font.xs }}>
								{o.badge}
							</text>
						) : null}
					</div>
				);
			})}
		</Row>
	);
}

/** A number with its label under it — the header's read-only telemetry. */
export function Stat({
	label,
	value,
	color = t.text,
	mono,
}: {
	label: string;
	value: string;
	color?: string;
	mono?: boolean;
}) {
	return (
		<Col gap={2} style={{ alignItems: "flex-end", flexShrink: 0 }}>
			<Text color={color} size={font.md} weight={600} mono={mono}>
				{value}
			</Text>
			<Text color={t.textFaint} size={font.xs}>
				{label}
			</Text>
		</Col>
	);
}

export function Field({
	label,
	value,
	placeholder,
	onChange,
	secret,
	hint,
	testId,
}: {
	label: string;
	value: string;
	placeholder?: string;
	onChange: (v: string) => void;
	secret?: boolean;
	hint?: string;
	testId?: string;
}) {
	return (
		<Col gap={5}>
			<Text color={t.textDim} size={font.sm} weight={500}>
				{label}
			</Text>
			<input
				testId={testId}
				value={value}
				placeholder={placeholder}
				onChange={(e) => onChange(e.value ?? "")}
				// Ctrl/Alt+Backspace word delete — not in GPUIX 0.7's Linux keymap.
				onKeyDown={(e) => handleWordEdit(e, value, onChange)}
				style={{
					backgroundColor: t.bgSunken,
					color: t.text,
					fontSize: font.base,
					fontFamily: secret ? t.mono : undefined,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: radius.sm,
					paddingLeft: 10,
					paddingRight: 10,
					paddingTop: 7,
					paddingBottom: 7,
					hover: { borderColor: t.borderFocus },
				}}
			/>
			{hint ? (
				<Text color={t.textFaint} size={font.xs}>
					{hint}
				</Text>
			) : null}
		</Col>
	);
}

/** A divider that does not need a border shorthand. */
export function Rule({ style }: { style?: Record<string, unknown> }) {
	return <div style={{ height: 1, backgroundColor: t.border, ...style }} />;
}

/** A read-only well: a stored message, a test result, a path. */
export function Well({
	children,
	tone: name = "neutral",
	mono = true,
	style,
}: {
	children?: ReactNode;
	tone?: Tone;
	mono?: boolean;
	style?: Record<string, unknown>;
}) {
	const c = tone(name);
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				padding: 10,
				borderRadius: radius.md,
				borderWidth: 1,
				borderColor: name === "neutral" ? t.border : c.border,
				backgroundColor: name === "neutral" ? t.bgSunken : c.bg,
				...style,
			}}
		>
			<text
				style={{
					color: name === "neutral" ? t.textDim : c.fg,
					fontSize: font.sm,
					fontFamily: mono ? t.mono : undefined,
				}}
			>
				{children}
			</text>
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
		<Col
			gap={8}
			style={{
				padding: 40,
				alignItems: "center",
				justifyContent: "center",
				flexGrow: 1,
			}}
		>
			<Text color={t.textDim} size={font.md} weight={500} align="center">
				{title}
			</Text>
			{hint ? (
				<Text
					color={t.textFaint}
					size={font.base}
					align="center"
					style={{ maxWidth: 420 }}
				>
					{hint}
				</Text>
			) : null}
			{action ? <div style={{ paddingTop: 4 }}>{action}</div> : null}
		</Col>
	);
}

/**
 * A scrolling region. Nested scrollers are unsupported in GPUI — an inner scroller
 * steals the wheel from its parent — so exactly one of these may be live per pane, and
 * panes must be siblings rather than nested.
 */
export function Scroll({
	children,
	style,
}: {
	children?: ReactNode;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				overflowY: "scroll",
				flexGrow: 1,
				minHeight: 0,
				...style,
			}}
		>
			{children}
		</div>
	);
}

/**
 * Centres a column of content and caps its measure. Long prose and forms are unreadable
 * at 1600px wide, and the alternative — a fixed pixel width — wastes a narrow window.
 */
export function Measure({
	children,
	max = 820,
	gap = 16,
	style,
}: {
	children?: ReactNode;
	max?: number;
	gap?: number;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap,
				width: "100%",
				maxWidth: max,
				alignSelf: "center",
				minWidth: 0,
				...style,
			}}
		>
			{children}
		</div>
	);
}
