/**
 * Modal, select and the submit helper.
 *
 * Radix gives us what GPUIX could not: a real portal, a focus trap, Escape to close and
 * an anchored listbox with keyboard navigation. The GPUIX version faked all four.
 */

import * as D from "@radix-ui/react-dialog";
import * as S from "@radix-ui/react-select";
import { type ReactNode, useState } from "react";
import { Button, cx, Spinner } from "./ui.tsx";

export function Modal({
	title,
	subtitle,
	children,
	onClose,
	onSubmit,
	submitLabel = "Save",
	submitting,
	submitDisabled,
	error,
	width = 520,
}: {
	title: string;
	subtitle?: string;
	children: ReactNode;
	onClose: () => void;
	onSubmit?: () => void;
	submitLabel?: string;
	submitting?: boolean;
	submitDisabled?: boolean;
	error?: string | null;
	width?: number;
}) {
	return (
		<D.Root open onOpenChange={(o) => !o && onClose()}>
			<D.Portal>
				<D.Overlay className="fixed inset-0 z-50 bg-black/72 data-[state=open]:animate-[fadeIn_150ms_ease-out]" />
				<D.Content
					style={{ width }}
					className={cx(
						"fixed top-1/2 left-1/2 z-50 flex max-h-[86vh] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)]",
						"-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl",
						"border border-strong bg-panel shadow-float",
						"data-[state=open]:animate-[popIn_160ms_cubic-bezier(0.16,1,0.3,1)]",
					)}
				>
					<div className="shrink-0 border-b border-subtle px-5 pt-4 pb-3">
						<D.Title className="text-lg font-semibold">{title}</D.Title>
						{subtitle ? (
							<D.Description className="mt-0.5 text-sm text-dim">
								{subtitle}
							</D.Description>
						) : null}
					</div>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							onSubmit?.();
						}}
						className="flex min-h-0 flex-1 flex-col"
					>
						<div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4">
							{children}
						</div>

						{error ? (
							<p className="mx-5 mb-3 shrink-0 rounded-sm border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
								{error}
							</p>
						) : null}

						<div className="flex shrink-0 items-center justify-end gap-2 border-t border-subtle px-5 py-3">
							<Button variant="subtle" onClick={onClose} type="button">
								Cancel
							</Button>
							{onSubmit ? (
								<Button
									variant="primary"
									type="submit"
									disabled={submitting || submitDisabled}
								>
									{submitting ? (
										<>
											<Spinner /> Working…
										</>
									) : (
										submitLabel
									)}
								</Button>
							) : null}
						</div>
					</form>
				</D.Content>
			</D.Portal>
		</D.Root>
	);
}

export function Dropdown({
	label,
	value,
	options,
	placeholder = "Choose…",
	hint,
	disabled,
	onChange,
}: {
	label?: string;
	value: string | undefined;
	options: { value: string; label: string }[];
	placeholder?: string;
	hint?: ReactNode;
	disabled?: boolean;
	onChange: (v: string) => void;
}) {
	const field = (
		<S.Root value={value} onValueChange={onChange} disabled={disabled}>
			<S.Trigger
				className={cx(
					"flex w-full items-center justify-between gap-2 rounded-md border border-subtle bg-sunken",
					"px-2.5 py-1.5 text-left text-sm transition-colors duration-150",
					"hover:border-strong focus:border-focus focus:outline-none",
					"disabled:opacity-50 data-placeholder:text-faint",
				)}
			>
				<S.Value placeholder={placeholder} />
				<S.Icon className="shrink-0 text-faint">▾</S.Icon>
			</S.Trigger>
			<S.Portal>
				<S.Content
					position="popper"
					sideOffset={4}
					className="z-60 max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-strong bg-raised p-1 shadow-float"
				>
					<S.Viewport>
						{options.map((o) => (
							<S.Item
								key={o.value}
								value={o.value}
								className="cursor-pointer rounded-xs px-2.5 py-1.5 text-sm outline-none data-highlighted:bg-hover data-[state=checked]:text-accent-hi"
							>
								<S.ItemText>{o.label}</S.ItemText>
							</S.Item>
						))}
					</S.Viewport>
				</S.Content>
			</S.Portal>
		</S.Root>
	);

	if (!label) return field;
	return (
		<label className="flex flex-col gap-1">
			<span className="text-xs font-medium text-dim">{label}</span>
			{field}
			{hint ? <span className="text-xs text-faint">{hint}</span> : null}
		</label>
	);
}

/** Busy/error plumbing every dialog repeats. */
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
		} finally {
			setBusy(false);
		}
	};

	return { busy, error, setError, run };
}
