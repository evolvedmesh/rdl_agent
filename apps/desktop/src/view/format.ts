/**
 * Formatting the view owns outright.
 *
 * The webview must import **types only** from `@layout/*`. Pulling in a value — even a
 * three-line one — makes the bundler follow that package's real module graph and drag
 * bun:sqlite, node:fs and Bun.spawn into a browser bundle.
 */

/** Human label for the UI: "Dev3 / HAWKS MIDDLE EAST". */
export const connectionLabel = (c: {
	environment: string;
	company: string;
}): string => `${c.environment} / ${c.company}`;
