/**
 * The store: bun:sqlite, migrated from version 0 on every open.
 *
 * Schema is report-projects.md §7. One decision it encodes, worth knowing because it is
 * expensive to change later: a layout row is `(report, client, file_path)`, so **each
 * client owns its own copy of a layout file**. If two clients ever need to share one
 * master template with per-client overrides, this table is where that starts, and the
 * change reaches the render queue and the UI as well.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Client = { id: string; name: string; createdAt: string };

export type ConnectionStatus =
	| "ok"
	| "unconsented"
	| "not_registered"
	| "forbidden"
	| "unreachable"
	| "unknown";

export type Connection = {
	id: string;
	clientId: string;
	label: string;
	tenantId: string;
	environment: string;
	company: string;
	isDefault: boolean;
	lastOkAt: string | null;
	lastStatus: ConnectionStatus | null;
};

export type Report = {
	id: string;
	reportId: number;
	name: string;
	source: string | null;
};

export type LayoutKind = "rdl" | "docx";

export type Layout = {
	id: string;
	reportId: string;
	clientId: string;
	connectionId: string | null;
	kind: LayoutKind;
	filePath: string;
	paramsXml: string | null;
};

export type RenderRow = {
	id: string;
	layoutId: string;
	contentHash: string;
	pdfPath: string | null;
	ok: boolean;
	error: string | null;
	durationMs: number | null;
	createdAt: string;
};

/**
 * A persisted agent chat. The JSON columns come back parsed but untyped on purpose:
 * their shape (`TimelineItem`, `UsageUpdate`, `ConfigOption`) is owned by `@layout/server`
 * and `@layout/acp`, which core must not import. The server casts them on read.
 */
export type PersistedSession = {
	id: string;
	layoutId: string;
	providerId: string;
	providerName: string;
	acpSessionId: string | null;
	status: string;
	modeId: string | null;
	configOptions: unknown;
	usage: unknown;
	plan: unknown;
	firstPdfPath: string | null;
	latestPdfPath: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
};

/** One ordered conversation entry. `item` is a parsed-but-untyped `TimelineItem`. */
export type PersistedTimelineItem = { seq: number; item: unknown };

/** A layout with everything the UI and the render engine need, in one query. */
export type LayoutDetail = Layout & {
	clientName: string;
	reportNumber: number;
	reportName: string;
	connection: Connection | null;
	lastRender: RenderRow | null;
};

const MIGRATIONS: { name: string; sql: string }[] = [
	{
		name: "0001-initial",
		sql: `
CREATE TABLE client (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE connection (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  environment   TEXT NOT NULL,
  company       TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  last_status   TEXT
);
CREATE INDEX idx_connection_client ON connection(client_id);

CREATE TABLE report (
  id         TEXT PRIMARY KEY,
  report_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  source     TEXT
);
CREATE UNIQUE INDEX idx_report_number ON report(report_id);

CREATE TABLE layout (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES report(id)     ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES client(id)     ON DELETE CASCADE,
  connection_id  TEXT          REFERENCES connection(id),
  kind           TEXT NOT NULL CHECK (kind IN ('rdl','docx')),
  file_path      TEXT NOT NULL,
  params_xml     TEXT,
  UNIQUE (report_id, client_id, file_path)
);
CREATE INDEX idx_layout_report ON layout(report_id);
CREATE INDEX idx_layout_client ON layout(client_id);

CREATE TABLE render (
  id            TEXT PRIMARY KEY,
  layout_id     TEXT NOT NULL REFERENCES layout(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,
  pdf_path      TEXT,
  ok            INTEGER NOT NULL,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
-- Makes the content-hash dedupe a single indexed lookup rather than a scan.
CREATE INDEX idx_render_dedupe ON render(layout_id, content_hash);
CREATE INDEX idx_render_recent ON render(layout_id, created_at DESC);

-- Exactly one row. The secret is NOT here: it lives in the OS keychain.
CREATE TABLE credentials (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  client_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  grant_type  TEXT NOT NULL
);
`,
	},
	{
		// Agent chats survive an app restart: the conversation is reopenable, and the
		// agent process can be resumed (session/load) for providers that support it.
		// The transcript is the source of truth for display — session/load only restores
		// the agent's own context — so `session_timeline` keeps every item verbatim, in
		// order, with `seq` so an in-place tool-call update rewrites its own row.
		name: "0002-sessions",
		sql: `
CREATE TABLE session (
  id              TEXT PRIMARY KEY,
  layout_id       TEXT NOT NULL REFERENCES layout(id) ON DELETE CASCADE,
  provider_id     TEXT NOT NULL,
  provider_name   TEXT NOT NULL,
  acp_session_id  TEXT,
  status          TEXT NOT NULL,
  mode_id         TEXT,
  config_options  TEXT,
  usage           TEXT,
  plan            TEXT,
  first_pdf_path  TEXT,
  latest_pdf_path TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_session_layout ON session(layout_id);

CREATE TABLE session_timeline (
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  item        TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`,
	},
];

const nowIso = () => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();

type ConnectionRow = {
	id: string;
	client_id: string;
	label: string;
	tenant_id: string;
	environment: string;
	company: string;
	is_default: number;
	last_ok_at: string | null;
	last_status: string | null;
};

type LayoutRow = {
	id: string;
	report_id: string;
	client_id: string;
	connection_id: string | null;
	kind: LayoutKind;
	file_path: string;
	params_xml: string | null;
};

type RenderRowRaw = {
	id: string;
	layout_id: string;
	content_hash: string;
	pdf_path: string | null;
	ok: number;
	error: string | null;
	duration_ms: number | null;
	created_at: string;
};

type SessionRowRaw = {
	id: string;
	layout_id: string;
	provider_id: string;
	provider_name: string;
	acp_session_id: string | null;
	status: string;
	mode_id: string | null;
	config_options: string | null;
	usage: string | null;
	plan: string | null;
	first_pdf_path: string | null;
	latest_pdf_path: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
};

const parseJson = (s: string | null): unknown => {
	if (s === null) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
};

const toPersistedSession = (r: SessionRowRaw): PersistedSession => ({
	id: r.id,
	layoutId: r.layout_id,
	providerId: r.provider_id,
	providerName: r.provider_name,
	acpSessionId: r.acp_session_id,
	status: r.status,
	modeId: r.mode_id,
	configOptions: parseJson(r.config_options),
	usage: parseJson(r.usage),
	plan: parseJson(r.plan),
	firstPdfPath: r.first_pdf_path,
	latestPdfPath: r.latest_pdf_path,
	error: r.error,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

const toConnection = (r: ConnectionRow): Connection => ({
	id: r.id,
	clientId: r.client_id,
	label: r.label,
	tenantId: r.tenant_id,
	environment: r.environment,
	company: r.company,
	isDefault: r.is_default === 1,
	lastOkAt: r.last_ok_at,
	lastStatus: (r.last_status as ConnectionStatus | null) ?? null,
});

const toLayout = (r: LayoutRow): Layout => ({
	id: r.id,
	reportId: r.report_id,
	clientId: r.client_id,
	connectionId: r.connection_id,
	kind: r.kind,
	filePath: r.file_path,
	paramsXml: r.params_xml,
});

const toRender = (r: RenderRowRaw): RenderRow => ({
	id: r.id,
	layoutId: r.layout_id,
	contentHash: r.content_hash,
	pdfPath: r.pdf_path,
	ok: r.ok === 1,
	error: r.error,
	durationMs: r.duration_ms,
	createdAt: r.created_at,
});

export class Store {
	readonly db: Database;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.migrate();
	}

	/** Migrations run from day one; the applied set is itself a table. */
	private migrate(): void {
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
		);
		const applied = new Set(
			this.db
				.query<{ name: string }, []>("SELECT name FROM migration")
				.all()
				.map((r) => r.name),
		);
		for (const m of MIGRATIONS) {
			if (applied.has(m.name)) continue;
			this.db.transaction(() => {
				this.db.exec(m.sql);
				this.db
					.query("INSERT INTO migration (name, applied_at) VALUES (?, ?)")
					.run(m.name, nowIso());
			})();
		}
	}

	close(): void {
		this.db.close();
	}

	// --- clients -------------------------------------------------------------

	createClient(name: string, id = newId()): Client {
		const client: Client = { id, name, createdAt: nowIso() };
		this.db
			.query("INSERT INTO client (id, name, created_at) VALUES (?, ?, ?)")
			.run(client.id, client.name, client.createdAt);
		return client;
	}

	clients(): Client[] {
		return this.db
			.query<{ id: string; name: string; created_at: string }, []>(
				"SELECT * FROM client ORDER BY name",
			)
			.all()
			.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
	}

	client(id: string): Client | null {
		const r = this.db
			.query<{ id: string; name: string; created_at: string }, [string]>(
				"SELECT * FROM client WHERE id = ?",
			)
			.get(id);
		return r ? { id: r.id, name: r.name, createdAt: r.created_at } : null;
	}

	// --- connections ---------------------------------------------------------

	createConnection(
		c: Omit<Connection, "id" | "lastOkAt" | "lastStatus"> & { id?: string },
	): Connection {
		const id = c.id ?? newId();
		this.db
			.query(
				`INSERT INTO connection (id, client_id, label, tenant_id, environment, company, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				c.clientId,
				c.label,
				c.tenantId,
				c.environment,
				c.company,
				c.isDefault ? 1 : 0,
			);
		return { ...c, id, lastOkAt: null, lastStatus: null };
	}

	connections(clientId?: string): Connection[] {
		const rows = clientId
			? this.db
					.query<ConnectionRow, [string]>(
						"SELECT * FROM connection WHERE client_id = ? ORDER BY is_default DESC, label",
					)
					.all(clientId)
			: this.db
					.query<ConnectionRow, []>("SELECT * FROM connection ORDER BY label")
					.all();
		return rows.map(toConnection);
	}

	connection(id: string): Connection | null {
		const r = this.db
			.query<ConnectionRow, [string]>("SELECT * FROM connection WHERE id = ?")
			.get(id);
		return r ? toConnection(r) : null;
	}

	setConnectionStatus(id: string, status: ConnectionStatus): void {
		this.db
			.query(
				"UPDATE connection SET last_status = ?, last_ok_at = CASE WHEN ? = 'ok' THEN ? ELSE last_ok_at END WHERE id = ?",
			)
			.run(status, status, nowIso(), id);
	}

	// --- reports -------------------------------------------------------------

	createReport(
		reportId: number,
		name: string,
		source: string | null = null,
		id = newId(),
	): Report {
		this.db
			.query(
				"INSERT INTO report (id, report_id, name, source) VALUES (?, ?, ?, ?)",
			)
			.run(id, reportId, name, source);
		return { id, reportId, name, source };
	}

	/** Reports are keyed on their BC number, so importing twice must not duplicate. */
	upsertReport(
		reportId: number,
		name: string,
		source: string | null = null,
	): Report {
		const existing = this.reportByNumber(reportId);
		if (existing) return existing;
		return this.createReport(reportId, name, source);
	}

	reports(): Report[] {
		return this.db
			.query<
				{ id: string; report_id: number; name: string; source: string | null },
				[]
			>("SELECT * FROM report ORDER BY report_id")
			.all()
			.map((r) => ({
				id: r.id,
				reportId: r.report_id,
				name: r.name,
				source: r.source,
			}));
	}

	report(id: string): Report | null {
		const r = this.db
			.query<
				{ id: string; report_id: number; name: string; source: string | null },
				[string]
			>("SELECT * FROM report WHERE id = ?")
			.get(id);
		return r
			? { id: r.id, reportId: r.report_id, name: r.name, source: r.source }
			: null;
	}

	reportByNumber(reportId: number): Report | null {
		const r = this.db
			.query<
				{ id: string; report_id: number; name: string; source: string | null },
				[number]
			>("SELECT * FROM report WHERE report_id = ?")
			.get(reportId);
		return r
			? { id: r.id, reportId: r.report_id, name: r.name, source: r.source }
			: null;
	}

	// --- layouts -------------------------------------------------------------

	createLayout(l: Omit<Layout, "id"> & { id?: string }): Layout {
		const id = l.id ?? newId();
		this.db
			.query(
				`INSERT INTO layout (id, report_id, client_id, connection_id, kind, file_path, params_xml)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				l.reportId,
				l.clientId,
				l.connectionId,
				l.kind,
				l.filePath,
				l.paramsXml,
			);
		return { ...l, id };
	}

	updateLayout(
		id: string,
		patch: Partial<Pick<Layout, "connectionId" | "paramsXml" | "filePath">>,
	): void {
		const sets: string[] = [];
		const args: (string | null)[] = [];
		if (patch.connectionId !== undefined) {
			sets.push("connection_id = ?");
			args.push(patch.connectionId);
		}
		if (patch.paramsXml !== undefined) {
			sets.push("params_xml = ?");
			args.push(patch.paramsXml);
		}
		if (patch.filePath !== undefined) {
			sets.push("file_path = ?");
			args.push(patch.filePath);
		}
		if (sets.length === 0) return;
		this.db
			.query(`UPDATE layout SET ${sets.join(", ")} WHERE id = ?`)
			.run(...args, id);
	}

	deleteLayout(id: string): void {
		this.db.query("DELETE FROM layout WHERE id = ?").run(id);
	}

	layout(id: string): Layout | null {
		const r = this.db
			.query<LayoutRow, [string]>("SELECT * FROM layout WHERE id = ?")
			.get(id);
		return r ? toLayout(r) : null;
	}

	layouts(): Layout[] {
		return this.db
			.query<LayoutRow, []>("SELECT * FROM layout")
			.all()
			.map(toLayout);
	}

	/**
	 * Everything a layout row needs to be rendered or displayed, in one query.
	 * The UI shows this table on both the report page and the client page — it is the
	 * same projection pivoted, which is exactly why it is one query and not two.
	 */
	layoutDetails(
		filter: { reportId?: string; clientId?: string; layoutId?: string } = {},
	): LayoutDetail[] {
		const where: string[] = [];
		const args: string[] = [];
		if (filter.reportId) {
			where.push("l.report_id = ?");
			args.push(filter.reportId);
		}
		if (filter.clientId) {
			where.push("l.client_id = ?");
			args.push(filter.clientId);
		}
		if (filter.layoutId) {
			where.push("l.id = ?");
			args.push(filter.layoutId);
		}
		const rows = this.db
			.query<
				LayoutRow & {
					client_name: string;
					report_number: number;
					report_name: string;
				},
				string[]
			>(
				`SELECT l.*, c.name AS client_name, r.report_id AS report_number, r.name AS report_name
           FROM layout l
           JOIN client c ON c.id = l.client_id
           JOIN report r ON r.id = l.report_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY r.report_id, c.name`,
			)
			.all(...args);

		return rows.map((r) => ({
			...toLayout(r),
			clientName: r.client_name,
			reportNumber: r.report_number,
			reportName: r.report_name,
			connection: r.connection_id ? this.connection(r.connection_id) : null,
			lastRender: this.lastRender(r.id),
		}));
	}

	// --- renders -------------------------------------------------------------

	recordRender(
		r: Omit<RenderRow, "id" | "createdAt"> & { id?: string },
	): RenderRow {
		const row: RenderRow = { ...r, id: r.id ?? newId(), createdAt: nowIso() };
		this.db
			.query(
				`INSERT INTO render (id, layout_id, content_hash, pdf_path, ok, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.id,
				row.layoutId,
				row.contentHash,
				row.pdfPath,
				row.ok ? 1 : 0,
				row.error,
				row.durationMs,
				row.createdAt,
			);
		return row;
	}

	lastRender(layoutId: string): RenderRow | null {
		const r = this.db
			.query<RenderRowRaw, [string]>(
				"SELECT * FROM render WHERE layout_id = ? ORDER BY created_at DESC LIMIT 1",
			)
			.get(layoutId);
		return r ? toRender(r) : null;
	}

	/** The dedupe lookup from report-projects.md §6: was this exact content rendered OK? */
	lastSuccessfulRender(
		layoutId: string,
		contentHash: string,
	): RenderRow | null {
		const r = this.db
			.query<RenderRowRaw, [string, string]>(
				"SELECT * FROM render WHERE layout_id = ? AND content_hash = ? AND ok = 1 ORDER BY created_at DESC LIMIT 1",
			)
			.get(layoutId, contentHash);
		return r ? toRender(r) : null;
	}

	renders(layoutId: string, limit = 50): RenderRow[] {
		return this.db
			.query<RenderRowRaw, [string, number]>(
				"SELECT * FROM render WHERE layout_id = ? ORDER BY created_at DESC LIMIT ?",
			)
			.all(layoutId, limit)
			.map(toRender);
	}

	/**
	 * Accumulates the answer to the open BC-latency question over real use, which is why
	 * duration_ms is stored on every render rather than only logged.
	 */
	renderStats(): {
		count: number;
		okCount: number;
		p50Ms: number | null;
		p95Ms: number | null;
	} {
		const durations = this.db
			.query<{ duration_ms: number }, []>(
				"SELECT duration_ms FROM render WHERE ok = 1 AND duration_ms IS NOT NULL ORDER BY duration_ms",
			)
			.all()
			.map((r) => r.duration_ms);
		const count =
			this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM render").get()
				?.n ?? 0;
		const pct = (p: number) => {
			if (durations.length === 0) return null;
			const rank = (p / 100) * (durations.length - 1);
			const lo = Math.floor(rank);
			const hi = Math.ceil(rank);
			const dLo = durations[lo] ?? 0;
			const dHi = durations[hi] ?? 0;
			return Math.round(dLo + (dHi - dLo) * (rank - lo));
		};
		return { count, okCount: durations.length, p50Ms: pct(50), p95Ms: pct(95) };
	}

	// --- agent chats -------------------------------------------------------------

	/** Insert or replace the session row. `created_at` is set once and kept thereafter. */
	upsertSession(s: {
		id: string;
		layoutId: string;
		providerId: string;
		providerName: string;
		acpSessionId: string | null;
		status: string;
		modeId: string | null;
		configOptions: unknown;
		usage: unknown;
		plan: unknown;
		firstPdfPath: string | null;
		latestPdfPath: string | null;
		error: string | null;
	}): void {
		const now = nowIso();
		this.db
			.query(
				`INSERT INTO session
           (id, layout_id, provider_id, provider_name, acp_session_id, status, mode_id,
            config_options, usage, plan, first_pdf_path, latest_pdf_path, error,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id     = excluded.provider_id,
           provider_name   = excluded.provider_name,
           acp_session_id  = excluded.acp_session_id,
           status          = excluded.status,
           mode_id         = excluded.mode_id,
           config_options  = excluded.config_options,
           usage           = excluded.usage,
           plan            = excluded.plan,
           first_pdf_path  = excluded.first_pdf_path,
           latest_pdf_path = excluded.latest_pdf_path,
           error           = excluded.error,
           updated_at      = excluded.updated_at`,
			)
			.run(
				s.id,
				s.layoutId,
				s.providerId,
				s.providerName,
				s.acpSessionId,
				s.status,
				s.modeId,
				s.configOptions === null ? null : JSON.stringify(s.configOptions),
				s.usage === null ? null : JSON.stringify(s.usage),
				s.plan === null ? null : JSON.stringify(s.plan),
				s.firstPdfPath,
				s.latestPdfPath,
				s.error,
				now,
				now,
			);
	}

	/** Oldest first, so the sidebar lists chats in the order they were started. */
	sessions(): PersistedSession[] {
		return this.db
			.query<SessionRowRaw, []>("SELECT * FROM session ORDER BY created_at ASC")
			.all()
			.map(toPersistedSession);
	}

	session(id: string): PersistedSession | null {
		const r = this.db
			.query<SessionRowRaw, [string]>("SELECT * FROM session WHERE id = ?")
			.get(id);
		return r ? toPersistedSession(r) : null;
	}

	/**
	 * Write one conversation entry. `seq` is monotonic per session; re-using one rewrites
	 * that row, which is how an in-place tool-call update (status pending → completed,
	 * plus its diff) persists without appending a duplicate.
	 */
	appendTimelineItem(sessionId: string, seq: number, item: unknown): void {
		this.db
			.query(
				`INSERT INTO session_timeline (session_id, seq, item) VALUES (?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET item = excluded.item`,
			)
			.run(sessionId, seq, JSON.stringify(item));
	}

	sessionTimeline(sessionId: string): PersistedTimelineItem[] {
		return this.db
			.query<{ seq: number; item: string }, [string]>(
				"SELECT seq, item FROM session_timeline WHERE session_id = ? ORDER BY seq ASC",
			)
			.all(sessionId)
			.map((r) => ({ seq: r.seq, item: parseJson(r.item) }));
	}

	/** Explicit forget. The timeline rows cascade. */
	deleteSession(id: string): void {
		this.db.query("DELETE FROM session WHERE id = ?").run(id);
	}

	// --- credentials (the secret is NOT stored here) --------------------------

	setCredentialsMeta(clientId: string, scope: string, grantType: string): void {
		this.db
			.query(
				`INSERT INTO credentials (id, client_id, scope, grant_type) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, scope = excluded.scope, grant_type = excluded.grant_type`,
			)
			.run(clientId, scope, grantType);
	}

	credentialsMeta(): {
		clientId: string;
		scope: string;
		grantType: string;
	} | null {
		const r = this.db
			.query<{ client_id: string; scope: string; grant_type: string }, []>(
				"SELECT * FROM credentials WHERE id = 1",
			)
			.get();
		return r
			? { clientId: r.client_id, scope: r.scope, grantType: r.grant_type }
			: null;
	}
}
