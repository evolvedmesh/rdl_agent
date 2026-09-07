#!/usr/bin/env bun
/**
 * Spike S1 — what is BC's render latency and throttle ceiling?
 *
 * This is the rate limiter of the whole loop. If p95 is above ~20s the interactive-loop
 * premise dies and the UX has to become async/batch.
 *
 * BOTH MODES HIT A LIVE BUSINESS CENTRAL TENANT. The burst mode deliberately tries to
 * provoke a 429 on someone's real environment, so it is gated behind --confirm and
 * should be run against a sandbox, out of hours.
 *
 *   bun spikes/bin/s1-latency.ts --n 20 --confirm
 *   bun spikes/bin/s1-latency.ts --burst 8 --confirm
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type BcError,
	CredentialsManager,
	defaultSecretStore,
	describeBcError,
	layoutFormatFor,
	previewLayout,
	Store,
	TokenCache,
} from "@layout/core";

type Args = { n: number; burst: number; confirm: boolean };

function parseArgs(argv: string[]): Args {
	const get = (flag: string, fallback: number) => {
		const i = argv.indexOf(flag);
		return i === -1 ? fallback : Number(argv[i + 1]);
	};
	return {
		n: get("--n", 20),
		burst: get("--burst", 0),
		confirm: argv.includes("--confirm"),
	};
}

const args = parseArgs(process.argv.slice(2));
const DATA_DIR =
	process.env.LAYOUT_DATA_DIR ??
	join(homedir(), ".local", "share", "layout-agent");
const store = new Store(join(DATA_DIR, "layout.db"));

// S1 measures one real layout against one real connection, so it takes the first
// configured layout rather than inventing a synthetic one.
const layout = store.layoutDetails()[0];
if (!layout?.connection) {
	console.error(
		"No layout with a connection configured. Run `bun apps/cli/src/index.ts import ...` first.",
	);
	process.exit(2);
}
const creds = await new CredentialsManager(
	store,
	await defaultSecretStore(join(DATA_DIR, "secret")),
).load();
if (!creds) {
	console.error(
		"No credentials configured. Set them in the app's Settings screen.",
	);
	process.exit(2);
}
const config = {
	credentials: creds,
	connection: layout.connection,
	reportId: layout.reportNumber,
	reportParamsXml: layout.paramsXml ?? "",
	layoutPath: layout.filePath,
	workDir: DATA_DIR,
};

const target = `${config.connection.environment} / ${config.connection.company} (tenant ${config.connection.tenantId})`;

if (!args.confirm) {
	console.error(
		[
			`S1 would issue live render calls against ${target}.`,
			``,
			args.burst > 0
				? `  BURST MODE: ${args.burst} concurrent renders, intended to provoke HTTP 429.`
				: `  SERIAL MODE: ${args.n} sequential renders of report ${config.reportId}.`,
			``,
			`Re-run with --confirm once you are pointed at a sandbox you are happy to load.`,
		].join("\n"),
	);
	process.exit(2);
}

const tokens = new TokenCache(config.credentials);
const layoutBase64 = Buffer.from(
	await Bun.file(config.layoutPath).arrayBuffer(),
).toString("base64");

const request = {
	connection: config.connection,
	reportId: config.reportId,
	reportParamsXml: config.reportParamsXml,
	layoutBase64,
	layoutFormat: layoutFormatFor(config.layoutPath),
	description: "S1 latency spike",
};

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN;
	const rank = (p / 100) * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

type Sample = {
	i: number;
	ms: number;
	ok: boolean;
	bytes?: number;
	error?: BcError;
};

async function serial(n: number): Promise<Sample[]> {
	const samples: Sample[] = [];
	for (let i = 1; i <= n; i++) {
		const r = await previewLayout(tokens, request);
		const s: Sample = r.ok
			? { i, ms: r.durationMs, ok: true, bytes: r.pdf.length }
			: { i, ms: r.durationMs, ok: false, error: r.error };
		samples.push(s);
		process.stderr.write(
			`  ${String(i).padStart(3)}/${n}  ${String(s.ms).padStart(6)}ms  ` +
				`${s.ok ? `ok ${s.bytes} bytes` : `FAIL ${s.error!.kind}`}\n`,
		);
		if (!s.ok && s.error!.kind === "throttle") {
			process.stderr.write(
				`  throttled — pausing ${s.error!.retryAfterMs}ms\n`,
			);
			await Bun.sleep(s.error!.retryAfterMs);
		}
	}
	return samples;
}

/** Bypasses the RenderEngine's per-connection queue on purpose: the queue is what we
 *  are trying to size, so this measures what BC does without one. */
async function burst(n: number): Promise<Sample[]> {
	const started = performance.now();
	const results = await Promise.all(
		Array.from({ length: n }, async (_, k): Promise<Sample> => {
			const r = await previewLayout(tokens, request);
			return r.ok
				? { i: k + 1, ms: r.durationMs, ok: true, bytes: r.pdf.length }
				: { i: k + 1, ms: r.durationMs, ok: false, error: r.error };
		}),
	);
	process.stderr.write(
		`  wall clock for ${n} concurrent: ${Math.round(performance.now() - started)}ms\n`,
	);
	return results;
}

console.error(
	`S1 against ${target}\nreport ${config.reportId}, layout ${config.layoutPath}\n`,
);

const mode = args.burst > 0 ? "burst" : "serial";
const samples = args.burst > 0 ? await burst(args.burst) : await serial(args.n);

const okMs = samples
	.filter((s) => s.ok)
	.map((s) => s.ms)
	.sort((a, b) => a - b);
const failures = samples.filter((s) => !s.ok);
const throttled = failures.filter((s) => s.error!.kind === "throttle");

const summary = {
	mode,
	target,
	reportId: config.reportId,
	samples: samples.length,
	ok: okMs.length,
	failed: failures.length,
	throttled: throttled.length,
	minMs: okMs[0] ?? null,
	p50Ms: okMs.length ? Math.round(percentile(okMs, 50)) : null,
	p95Ms: okMs.length ? Math.round(percentile(okMs, 95)) : null,
	maxMs: okMs[okMs.length - 1] ?? null,
	ranAt: new Date().toISOString(),
};

await mkdir(config.workDir, { recursive: true });
const out = `${config.workDir}/s1-${mode}-${summary.ranAt.replace(/[:.]/g, "-")}.json`;
await Bun.write(out, JSON.stringify({ summary, samples }, null, 2));

console.log("");
console.log(
	`  n=${summary.samples}  ok=${summary.ok}  failed=${summary.failed}  throttled=${summary.throttled}`,
);
console.log(
	`  min ${summary.minMs}ms   p50 ${summary.p50Ms}ms   p95 ${summary.p95Ms}ms   max ${summary.maxMs}ms`,
);
console.log("");

if (summary.p95Ms !== null) {
	console.log(
		summary.p95Ms > 20_000
			? `  VERDICT: p95 ${summary.p95Ms}ms exceeds the 20s kill criterion. The interactive\n` +
					`  loop premise does not hold — Phase 4's UX must be async/batch. Replan.`
			: `  VERDICT: p95 ${summary.p95Ms}ms is within the 20s criterion. An interactive loop\n` +
					`  is viable; a ${Math.round((summary.p95Ms / 1000) * 10)}s wall for a 10-iteration session.`,
	);
}
for (const f of failures.slice(0, 5))
	console.log(`  failure: ${describeBcError(f.error!)}`);
console.log(`\n  written to ${out}`);
