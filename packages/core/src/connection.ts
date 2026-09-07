/**
 * URL composition. Never store an expanded URL: it cannot survive varying tenant,
 * environment or company, which is exactly what a multi-client tool varies.
 */
import type { Connection } from "./store.ts";

/**
 * Two escaping steps a hand-written URL gets away with until it doesn't: an OData string
 * literal doubles its apostrophes (O'Brien -> 'O''Brien'), and the result still needs URI
 * encoding. A company name containing a space survives naively; one containing an
 * apostrophe or an ampersand does not.
 */
export function odataUrl(
	c: Pick<Connection, "tenantId" | "environment" | "company">,
	action: string,
): string {
	const literal = `'${c.company.replaceAll("'", "''")}'`;
	return (
		`https://api.businesscentral.dynamics.com/v2.0/${c.tenantId}/${c.environment}` +
		`/ODataV4/${action}?company=${encodeURIComponent(literal)}`
	);
}

export function tokenUrl(tenantId: string): string {
	return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

/** Human label for the UI: "Dev3 / HAWKS MIDDLE EAST". */
export function connectionLabel(
	c: Pick<Connection, "environment" | "company">,
): string {
	return `${c.environment} / ${c.company}`;
}
