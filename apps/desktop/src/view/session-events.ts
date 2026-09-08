/**
 * Applying a live session event to the view we already hold.
 *
 * The GPUIX build refetched the *entire* app state on every session event, which meant
 * a full `/api/state` round trip per streamed token. The server already sends enough to
 * patch in place; only structural changes need a refresh.
 */

import type { SessionEvent, SessionView } from "@layout/server";

export function applySessionEvent(
	view: SessionView,
	event: SessionEvent,
): SessionView {
	switch (event.type) {
		case "status":
			return { ...view, status: event.status };

		case "timeline": {
			// Tool calls are updated in place as they progress, so an item that already
			// exists replaces rather than appends.
			const i = view.timeline.findIndex((t) => t.id === event.item.id);
			if (i === -1)
				return { ...view, timeline: [...view.timeline, event.item] };
			const timeline = [...view.timeline];
			timeline[i] = event.item;
			return { ...view, timeline };
		}

		case "plan":
			return { ...view, plan: event.entries };

		case "usage":
			return { ...view, usage: event.usage };

		case "permission":
			return { ...view, permission: event.request };

		case "config":
			return { ...view, modeId: event.modeId };

		case "error":
			return { ...view, error: event.message };

		case "render":
			return {
				...view,
				latestPdfPath: event.pdfPath,
				firstPdfPath: view.firstPdfPath ?? event.pdfPath,
			};

		default:
			return view;
	}
}

/** Whether an event changes something outside the session itself. */
export function needsFullRefresh(event: SessionEvent): boolean {
	return event.type === "render";
}
