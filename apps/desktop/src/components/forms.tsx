/**
 * Form scaffolding: a modal panel, a dropdown, and a multi-line editor.
 *
 * There is no webview, so GPUIX has no file dialog of its own — Browse hands off to the
 * desktop's own chooser through core (see `picker.ts`). Every path field also stays
 * typeable, which is the fallback when no chooser is installed and the faster route when
 * the layout is already open in an editor to copy the path from.
 */

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@gpuix/react/select";
import { type ReactNode, useState } from "react";
import { font, radius, shadow, t } from "../theme.ts";
import { handleWordEdit } from "./textedit.ts";
import { Button, Col, IconButton, Row, Text, useBreakpoint } from "./ui.tsx";

/**
 * A modal. GPUIX is single-window with no portal, so this is an absolutely positioned
 * overlay at the app root that covers everything below it.
 *
 * `width` is the panel's preferred width, not its actual one: a dialog wider than the
 * window is a dialog with its buttons off-screen, so it is always clamped to what is
 * there. The same goes for its height, which is why the body is the scrolling part.
 */
export function Modal({
	title,
	subtitle,
	children,
	onClose,
	onSubmit,
	submitLabel = "Save",
	submitting,
	error,
	width = 520,
}: {
	title: string;
	subtitle?: string;
	children?: ReactNode;
	onClose: () => void;
	onSubmit?: () => void;
	submitLabel?: string;
	submitting?: boolean;
	error?: string | null;
	width?: number;
}) {
	const b = useBreakpoint();
	const panelWidth = Math.max(300, Math.min(width, b.width - 32));
	const panelMaxHeight = Math.max(320, b.height - 96);

	return (
		<div
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				padding: 16,
				backgroundColor: t.overlay,
			}}
		>
			<Col
				gap={0}
				style={{
					width: panelWidth,
					maxHeight: panelMaxHeight,
					minHeight: 0,
					borderRadius: radius.xl,
					borderWidth: 1,
					borderColor: t.borderStrong,
					backgroundColor: t.bgPanel,
					boxShadow: shadow.lg,
				}}
			>
				<Row
					gap={10}
					align="flex-start"
					style={{
						paddingLeft: 18,
						paddingRight: 12,
						paddingTop: 16,
						paddingBottom: 14,
						borderBottomWidth: 1,
						borderColor: t.border,
						flexShrink: 0,
					}}
				>
					<Col gap={3} style={{ flexGrow: 1, minWidth: 0 }}>
						<Text size={font.lg} weight={600} clamp={2}>
							{title}
						</Text>
						{subtitle ? (
							<Text color={t.textDim} size={font.base} lineHeight={18}>
								{subtitle}
							</Text>
						) : null}
					</Col>
					<IconButton glyph="✕" title="close dialog" onClick={onClose} />
				</Row>

				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 13,
						paddingLeft: 18,
						paddingRight: 18,
						paddingTop: 16,
						paddingBottom: 16,
						overflowY: "scroll",
						flexGrow: 1,
						minHeight: 0,
					}}
				>
					{children}
				</div>

				{error ? (
					<div
						style={{
							display: "flex",
							flexShrink: 0,
							paddingLeft: 18,
							paddingRight: 18,
							paddingTop: 10,
							paddingBottom: 10,
							backgroundColor: t.dangerSoft,
							borderTopWidth: 1,
							borderColor: "#5c2f33",
						}}
					>
						<text style={{ color: t.danger, fontSize: font.base }}>
							{error}
						</text>
					</div>
				) : null}

				<Row
					gap={8}
					style={{
						padding: 14,
						borderTopWidth: 1,
						borderColor: t.border,
						backgroundColor: t.bgSunken,
						borderBottomLeftRadius: radius.xl,
						borderBottomRightRadius: radius.xl,
						flexShrink: 0,
					}}
				>
					<div style={{ flexGrow: 1 }} />
					<Button label="Cancel" variant="ghost" onClick={onClose} />
					{onSubmit ? (
						<Button
							label={submitting ? "Saving…" : submitLabel}
							variant="primary"
							onClick={onSubmit}
							disabled={submitting}
						/>
					) : null}
				</Row>
			</Col>
		</div>
	);
}

export function Dropdown({
	label,
	value,
	options,
	placeholder,
	hint,
	onChange,
}: {
	label: string;
	value: string | null;
	options: { value: string; label: string }[];
	placeholder?: string;
	hint?: string;
	onChange: (v: string) => void;
}) {
	const current = options.find((o) => o.value === value);
	return (
		<Col gap={5}>
			<Text color={t.textDim} size={font.sm} weight={500}>
				{label}
			</Text>
			<Select value={value ?? undefined} onValueChange={onChange}>
				<SelectTrigger
					style={{
						display: "flex",
						flexDirection: "row",
						alignItems: "center",
						backgroundColor: t.bgSunken,
						borderWidth: 1,
						borderColor: t.borderStrong,
						borderRadius: radius.sm,
						paddingLeft: 10,
						paddingRight: 10,
						paddingTop: 7,
						paddingBottom: 7,
						cursor: "pointer",
						hover: { borderColor: t.borderFocus },
					}}
				>
					<SelectValue placeholder={placeholder ?? "Select…"}>
						<text
							style={{
								color: current ? t.text : t.textFaint,
								fontSize: font.base,
								lineClamp: 1,
							}}
						>
							{current?.label ?? placeholder ?? "Select…"}
						</text>
					</SelectValue>
				</SelectTrigger>
				<SelectContent
					style={{
						backgroundColor: t.bgRaised,
						borderWidth: 1,
						borderColor: t.borderStrong,
						borderRadius: radius.md,
						boxShadow: shadow.md,
						padding: 4,
					}}
				>
					{options.map((o) => (
						<SelectItem
							key={o.value}
							value={o.value}
							style={{
								paddingLeft: 9,
								paddingRight: 9,
								paddingTop: 6,
								paddingBottom: 6,
								borderRadius: radius.xs,
							}}
						>
							<text style={{ color: t.text, fontSize: font.base }}>
								{o.label}
							</text>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{hint ? (
				<Text color={t.textFaint} size={font.xs}>
					{hint}
				</Text>
			) : null}
		</Col>
	);
}

/** Multi-line editor, for reportParamsXml and anything else that is a blob of text. */
export function TextArea({
	label,
	value,
	placeholder,
	hint,
	rows = 8,
	onChange,
}: {
	label: string;
	value: string;
	placeholder?: string;
	hint?: string;
	rows?: number;
	onChange: (v: string) => void;
}) {
	return (
		<Col gap={5}>
			<Text color={t.textDim} size={font.sm} weight={500}>
				{label}
			</Text>
			<textarea
				value={value}
				placeholder={placeholder}
				minRows={rows}
				maxRows={rows + 8}
				onChange={(e) => onChange(e.value ?? "")}
				// Ctrl/Alt+Backspace word delete — not in GPUIX 0.7's Linux keymap.
				onKeyDown={(e) => handleWordEdit(e, value, onChange)}
				style={{
					backgroundColor: t.bgSunken,
					color: t.text,
					fontSize: font.sm,
					fontFamily: t.mono,
					lineHeight: 17,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: radius.sm,
					paddingLeft: 10,
					paddingRight: 10,
					paddingTop: 8,
					paddingBottom: 8,
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

/** Small helper for forms that need their own busy/error state. */
export function useSubmit() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await fn();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			throw e;
		} finally {
			setBusy(false);
		}
	};
	return { busy, error, setError, run };
}
