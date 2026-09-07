/**
 * Shared primitives.
 *
 * Four GPUIX rules are enforced here so screens do not have to remember them:
 *   - every <text> carries an explicit `color`; GPUI does not inherit it, and an
 *     uncoloured run paints black and vanishes on a dark surface
 *   - `div` is block by default, so any row or column sets `display: "flex"`
 *   - there are no shorthand padding/margin/border props
 *   - a <text> takes exactly ONE string child. Several children become separate runs
 *     that wrap between each other, so `{n} items` renders as two stacked lines —
 *     always interpolate into one template literal instead.
 */
import type { ReactNode } from "react";
import { t } from "../theme.ts";
import { handleWordEdit } from "./textedit.ts";

export function Row({
	children,
	gap = 8,
	align = "center",
	justify,
	grow,
	wrap,
	style,
}: {
	children?: ReactNode;
	gap?: number;
	align?: string;
	justify?: string;
	grow?: number;
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
	grow,
	style,
}: {
	children?: ReactNode;
	gap?: number;
	grow?: number;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap,
				flexGrow: grow,
				...style,
			}}
		>
			{children}
		</div>
	);
}

export function Text({
	children,
	color = t.text,
	size = 13,
	weight,
	mono,
	clamp,
	align,
	style,
}: {
	children?: ReactNode;
	color?: string;
	size?: number;
	weight?: number | string;
	mono?: boolean;
	clamp?: number;
	align?: string;
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
				textAlign: align,
				...style,
			}}
		>
			{children}
		</text>
	);
}

export function Button({
	label,
	onClick,
	variant = "default",
	disabled,
	testId,
}: {
	label: string;
	onClick?: () => void;
	variant?: "default" | "primary" | "danger" | "ghost";
	disabled?: boolean;
	testId?: string;
}) {
	const palette = {
		default: { bg: t.bgRaised, fg: t.text, border: t.borderStrong },
		primary: { bg: t.accentDim, fg: "#ffffff", border: t.accent },
		danger: { bg: "#3a1f22", fg: t.danger, border: "#5c2f33" },
		ghost: { bg: "transparent", fg: t.textDim, border: "transparent" },
	}[variant];

	return (
		<div
			testId={testId}
			onClick={disabled ? undefined : onClick}
			style={{
				display: "flex",
				alignItems: "center",
				paddingLeft: 12,
				paddingRight: 12,
				paddingTop: 6,
				paddingBottom: 6,
				borderRadius: 6,
				borderWidth: 1,
				borderColor: palette.border,
				backgroundColor: palette.bg,
				opacity: disabled ? 0.45 : 1,
				cursor: disabled ? "default" : "pointer",
				hover: disabled ? {} : { backgroundColor: t.bgHover },
			}}
		>
			<text style={{ color: palette.fg, fontSize: 12.5, fontWeight: 500 }}>
				{label}
			</text>
		</div>
	);
}

export function Badge({ label, color }: { label: string; color: string }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				// A flex child stretches to fill its cross axis; a badge must hug its label.
				alignSelf: "flex-start",
				flexGrow: 0,
				flexShrink: 0,
				paddingLeft: 7,
				paddingRight: 7,
				paddingTop: 2,
				paddingBottom: 2,
				borderRadius: 4,
				borderWidth: 1,
				borderColor: color,
				backgroundColor: "transparent",
			}}
		>
			<text style={{ color, fontSize: 11, fontWeight: 500 }}>{label}</text>
		</div>
	);
}

export function Card({
	children,
	onClick,
	padding = 14,
	style,
}: {
	children?: ReactNode;
	onClick?: () => void;
	padding?: number;
	style?: Record<string, unknown>;
}) {
	return (
		<div
			onClick={onClick}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding,
				borderRadius: 10,
				borderWidth: 1,
				borderColor: t.border,
				backgroundColor: t.bgPanel,
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

export function Field({
	label,
	value,
	placeholder,
	onChange,
	secret,
	testId,
}: {
	label: string;
	value: string;
	placeholder?: string;
	onChange: (v: string) => void;
	secret?: boolean;
	testId?: string;
}) {
	return (
		<Col gap={5}>
			<Text color={t.textDim} size={11.5}>
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
					backgroundColor: t.bg,
					color: t.text,
					fontSize: 12.5,
					fontFamily: secret ? t.mono : undefined,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: 6,
					paddingLeft: 9,
					paddingRight: 9,
					paddingTop: 6,
					paddingBottom: 6,
				}}
			/>
		</Col>
	);
}

/** A divider that does not need a border shorthand. */
export function Rule() {
	return <div style={{ height: 1, backgroundColor: t.border }} />;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
	return (
		<Col gap={6} style={{ padding: 28, alignItems: "center" }}>
			<Text color={t.textDim} size={14}>
				{title}
			</Text>
			{hint ? (
				<Text color={t.textFaint} size={12}>
					{hint}
				</Text>
			) : null}
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
