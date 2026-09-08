import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { IconButton } from "./ui.tsx";

/**
 * A dismissible notice, floating clear of the layout rather than pushing it down.
 * Six seconds: long enough to read a BC error, short enough not to become furniture.
 */
export function Toast({
	message,
	onDismiss,
}: {
	message: string | null;
	onDismiss: () => void;
}) {
	useEffect(() => {
		if (!message) return;
		const id = setTimeout(onDismiss, 6000);
		return () => clearTimeout(id);
	}, [message, onDismiss]);

	return (
		<AnimatePresence>
			{message ? (
				<motion.div
					initial={{ opacity: 0, y: 12, scale: 0.97 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{ opacity: 0, y: 8, scale: 0.98 }}
					transition={{ duration: 0.18, ease: "easeOut" }}
					role="status"
					className="absolute bottom-4 left-1/2 z-50 flex max-w-[min(680px,calc(100%-2rem))] -translate-x-1/2 items-start gap-2.5 rounded-lg border border-danger-line bg-danger-soft px-3.5 py-2.5 shadow-float"
				>
					<span className="mt-px shrink-0 text-danger">!</span>
					<span className="min-w-0 flex-1 text-sm wrap-break-word text-fg">
						{message}
					</span>
					<IconButton label="dismiss" onClick={onDismiss} className="-mr-1">
						<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
							<path
								d="M4 4l8 8M12 4l-8 8"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
							/>
						</svg>
					</IconButton>
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
