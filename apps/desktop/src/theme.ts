/**
 * One palette, applied explicitly everywhere.
 *
 * GPUI does not inherit colour: a <text> without an explicit `color` paints black and
 * disappears on a dark surface. So every text colour in this app comes from here, and
 * there is no "default" to fall back on.
 */
export const t = {
	bg: "#0e0f13",
	bgPanel: "#15171d",
	bgRaised: "#1c1f27",
	bgHover: "#232733",
	bgActive: "#2b3040",

	border: "#262a35",
	borderStrong: "#343a49",

	text: "#e6e8ee",
	textDim: "#9aa1b1",
	textFaint: "#646b7d",

	accent: "#6ea8fe",
	accentDim: "#3b6cb5",

	ok: "#5fd39a",
	warn: "#e8c26a",
	danger: "#f2777a",
	info: "#8fb8ff",

	mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export const statusColor = (s: string | null | undefined): string => {
	switch (s) {
		case "ok":
			return t.ok;
		case "failed":
		case "forbidden":
		case "unreachable":
			return t.danger;
		case "mixed":
		case "unconsented":
		case "not_registered":
			return t.warn;
		default:
			return t.textFaint;
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
