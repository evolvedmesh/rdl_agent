/**
 * One palette and one set of scales, applied explicitly everywhere.
 *
 * GPUI does not inherit colour: a <text> without an explicit `color` paints black and
 * disappears on a dark surface. So every text colour in this app comes from here, and
 * there is no "default" to fall back on.
 *
 * The surfaces form a deliberate elevation ladder — sunken (wells and inputs), canvas,
 * panel, raised, hover, active. Depth is the only cue available for hierarchy in an
 * immediate-mode renderer with no blur and no backdrop filter, so it is used
 * consistently rather than decoratively.
 */

export const t = {
	/** Wells: inputs, code blocks, anything that should read as cut into the page. */
	bgSunken: "#080a0e",
	bg: "#0c0e13",
	bgPanel: "#12151c",
	bgRaised: "#191d26",
	bgHover: "#20242f",
	bgActive: "#282e3d",
	/** The scrim behind a modal. */
	overlay: "#05070ad9",

	border: "#212633",
	borderStrong: "#333a4a",
	borderFocus: "#4a7fd4",

	text: "#e8eaf0",
	textDim: "#a2aab9",
	textFaint: "#6b7383",
	/** On top of a saturated accent fill. */
	textOn: "#ffffff",

	accent: "#7aa2f7",
	accentHi: "#a3c0ff",
	accentDim: "#3a5da8",
	accentSoft: "#1a2340",

	ok: "#7ee0a8",
	okSoft: "#122a20",
	warn: "#f0c674",
	warnSoft: "#2b2415",
	danger: "#f47b7e",
	dangerSoft: "#2c1719",
	info: "#8fb8ff",
	infoSoft: "#18223a",

	mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export const radius = {
	xs: 4,
	sm: 6,
	md: 8,
	lg: 12,
	xl: 16,
	pill: 999,
} as const;

export const font = {
	xs: 10.5,
	sm: 11.5,
	base: 12.5,
	md: 13.5,
	lg: 15,
	xl: 18,
	xxl: 22,
} as const;

/**
 * `boxShadow` is a single shadow, not a list, so each of these is tuned to read as
 * elevation on its own rather than as a stack of two.
 */
export const shadow = {
	sm: {
		offsetX: 0,
		offsetY: 1,
		blurRadius: 3,
		spreadRadius: 0,
		color: "#00000066",
	},
	md: {
		offsetX: 0,
		offsetY: 10,
		blurRadius: 28,
		spreadRadius: -8,
		color: "#000000a6",
	},
	lg: {
		offsetX: 0,
		offsetY: 28,
		blurRadius: 64,
		spreadRadius: -16,
		color: "#000000cc",
	},
} as const;

/**
 * Window widths where the shell changes shape. There are no media queries here — every
 * screen reads `useBreakpoint()` and branches, so these are the only two numbers that
 * decide it.
 */
export const bp = {
	/** Below this the two-pane splits collapse to one pane with a switcher. */
	compact: 1180,
	/** Below this the sidebar stops being docked and becomes an overlay. */
	narrow: 940,
} as const;

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

/** Foreground / soft fill / border for a tone, so a badge or a banner needs one lookup. */
export const tone = (
	name: Tone,
): { fg: string; bg: string; border: string } => {
	switch (name) {
		case "accent":
			return { fg: t.accentHi, bg: t.accentSoft, border: "#2d4478" };
		case "ok":
			return { fg: t.ok, bg: t.okSoft, border: "#1e4a36" };
		case "warn":
			return { fg: t.warn, bg: t.warnSoft, border: "#4a3f20" };
		case "danger":
			return { fg: t.danger, bg: t.dangerSoft, border: "#5c2f33" };
		case "info":
			return { fg: t.info, bg: t.infoSoft, border: "#2b3a5e" };
		default:
			return { fg: t.textDim, bg: t.bgRaised, border: t.borderStrong };
	}
};

type Stop = { color: string; position: number };

/** The brand mark's fill, and the primary button's. */
export const accentGradient: {
	type: "linear-gradient";
	angle: number;
	stops: [Stop, Stop];
} = {
	type: "linear-gradient",
	angle: 160,
	stops: [
		{ color: "#5480e0", position: 0 },
		{ color: "#3a5da8", position: 1 },
	],
};

export const accentGradientHover: typeof accentGradient = {
	type: "linear-gradient",
	angle: 160,
	stops: [
		{ color: "#658dea", position: 0 },
		{ color: "#4569b8", position: 1 },
	],
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

export const statusColor = (s: string | null | undefined): string =>
	tone(statusTone(s)).fg;

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
