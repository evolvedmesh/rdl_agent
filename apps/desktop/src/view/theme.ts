/**
 * The theme's logic half. Colours live in index.css as Tailwind `@theme` tokens; what
 * survives as TypeScript is the mapping from domain state to a tone, which is a
 * decision rather than a style.
 */

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

/** Tailwind class triplet for a tone, so a badge or banner needs one lookup. */
export const toneClass = (name: Tone): string => {
	switch (name) {
		case "accent":
			return "text-accent-hi bg-accent-soft border-accent-line";
		case "ok":
			return "text-ok bg-ok-soft border-ok-line";
		case "warn":
			return "text-warn bg-warn-soft border-warn-line";
		case "danger":
			return "text-danger bg-danger-soft border-danger-line";
		case "info":
			return "text-info bg-info-soft border-info-line";
		default:
			return "text-dim bg-raised border-strong";
	}
};

export const toneText = (name: Tone): string => {
	switch (name) {
		case "accent":
			return "text-accent-hi";
		case "ok":
			return "text-ok";
		case "warn":
			return "text-warn";
		case "danger":
			return "text-danger";
		case "info":
			return "text-info";
		default:
			return "text-dim";
	}
};

export const statusTone = (s: string | null | undefined): Tone => {
	switch (s) {
		case "ok":
			return "ok";
		case "failed":
		case "forbidden":
		case "unreachable":
			return "danger";
		case "mixed":
		case "unconsented":
		case "not_registered":
			return "warn";
		default:
			return "neutral";
	}
};

export const statusLabel = (s: string | null | undefined): string => {
	switch (s) {
		case "ok":
			return "OK";
		case "unconsented":
			return "not consented";
		case "not_registered":
			return "not registered in BC";
		case "forbidden":
			return "no permissions";
		case "unreachable":
			return "unreachable";
		case "never":
			return "never rendered";
		case "failed":
			return "render failed";
		case "mixed":
			return "some failing";
		default:
			return "unknown";
	}
};
