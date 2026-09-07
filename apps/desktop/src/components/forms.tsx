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
import { t } from "../theme.ts";
import { handleWordEdit } from "./textedit.ts";
import { Button, Col, Row, Text } from "./ui.tsx";

/**
 * A modal. GPUIX is single-window with no portal, so this is an absolutely positioned
 * overlay at the app root that covers everything below it.
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
				backgroundColor: "#000000cc",
				paddingTop: 60,
			}}
		>
			<Col
				gap={0}
				style={{
					width,
					maxHeight: 620,
					borderRadius: 12,
					borderWidth: 1,
					borderColor: t.borderStrong,
					backgroundColor: t.bgPanel,
				}}
			>
				<Col
					gap={3}
					style={{ padding: 16, borderBottomWidth: 1, borderColor: t.border }}
				>
					<Text size={15} weight={600}>
						{title}
					</Text>
					{subtitle ? (
						<Text color={t.textDim} size={12}>
							{subtitle}
						</Text>
					) : null}
				</Col>

				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 12,
						padding: 16,
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
							paddingLeft: 16,
							paddingRight: 16,
							paddingTop: 8,
							paddingBottom: 8,
							backgroundColor: "#2a1719",
						}}
					>
						<text style={{ color: t.danger, fontSize: 12 }}>{error}</text>
					</div>
				) : null}

				<Row
					gap={8}
					style={{ padding: 14, borderTopWidth: 1, borderColor: t.border }}
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
	onChange,
}: {
	label: string;
	value: string | null;
	options: { value: string; label: string }[];
	placeholder?: string;
	onChange: (v: string) => void;
}) {
	const current = options.find((o) => o.value === value);
	return (
		<Col gap={5}>
			<Text color={t.textDim} size={11.5}>
				{label}
			</Text>
			<Select value={value ?? undefined} onValueChange={onChange}>
				<SelectTrigger
					style={{
						backgroundColor: t.bg,
						borderWidth: 1,
						borderColor: t.borderStrong,
						borderRadius: 6,
						paddingLeft: 9,
						paddingRight: 9,
						paddingTop: 6,
						paddingBottom: 6,
					}}
				>
					<SelectValue placeholder={placeholder ?? "Select…"}>
						<text
							style={{ color: current ? t.text : t.textFaint, fontSize: 12.5 }}
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
							<text style={{ color: t.text, fontSize: 12.5 }}>{o.label}</text>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
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
			<Text color={t.textDim} size={11.5}>
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
					backgroundColor: t.bg,
					color: t.text,
					fontSize: 11.5,
					fontFamily: t.mono,
					borderWidth: 1,
					borderColor: t.borderStrong,
					borderRadius: 6,
					paddingLeft: 9,
					paddingRight: 9,
					paddingTop: 7,
					paddingBottom: 7,
				}}
			/>
			{hint ? (
				<Text color={t.textFaint} size={11}>
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
