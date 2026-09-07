# Report Projects: Multi-Client, Multi-Connection

`rdl_previewer` is a single-purpose script: one RDL, one tenant, one environment, one
company, one PDF, all resolved at startup from two JSON files. Every piece of state it
owns is a module-level singleton. This document is the plan for turning that into a
store of many reports, each with many clients, each with their own layouts and their own
BC connection.

## 1. Vocabulary

Your description used "client" and "project" loosely, so pinning terms down first —
these names should end up in the code and the UI.

| Term | Meaning | Example |
|---|---|---|
| **Client** | A customer organisation whose reports we maintain | Hawks Middle East |
| **Connection** | A reachable BC target: tenant + environment + company | Hawks / `Dev3` / `HAWKS MIDDLE EAST` |
| **Report** | A BC report definition, identified by its numeric ID | `61206` Calc. and Post VAT Settlement |
| **Layout** | One client's template for one report — the binding | Hawks' `Default.rdl` for 61206 |
| **Layout file** | The actual `.rdl` / `.docx` on disk, owned by the user | `~/reports/hawks/61206/Default.rdl` |
| **Preview session** | A live render loop over one layout | (transient) |

"Report project" in your phrasing maps to **Report** — the thing the home page lists,
containing its clients and their layouts.

## 2. Domain model

```
Credentials (exactly one — shared Entra app)
  clientId, clientSecret, scope, grantType

Client ──1:N──> Connection            (Production, Sandbox, …)
  │
  └──────────────────┐
                     ▼
Report ──1:N──> Layout ──N:1──> Connection
 61206          │  kind: rdl | docx
                │  filePath
                └─ paramsXml
```

The home page is a projection over `Report`; a report detail page lists its `Layout`
rows grouped by client:

```
Report 61206 · Calc. and Post VAT Settlement
├── Hawks Middle East   Default.rdl    RDL    Dev3 / HAWKS MIDDLE EAST    ✓ 2h ago
├── Acme Trading        Acme.rdl       RDL    Production / ACME           ✗ render failed
└── Globex              Globex.docx    DOCX   Production / GLOBEX         — never rendered
```

### Four modelling decisions worth arguing about

**`paramsXml` belongs on the Layout, not the Report.** The sample in
`rdl_preview_config.json` contains `DocNo = PPI-22-00012`, `GLAccSettle."No." = 2104`,
and a June 2025 date range. Those are *Hawks' data*. Acme's tenant has none of those
records, so a report-level params blob would render empty or error for every other
client. Each binding needs its own preview parameters. (A report-level *default* that
new layouts copy is fine — just not the source of truth.)

**Client → Connection is 1:N, not 1:1.** You said "tenant id, company and environment
per client", which reads as one triple each. But the normal workflow is to iterate a
layout against a sandbox and verify against production — and a client with several
companies (very common) needs one connection per company. Model it as a list with one
marked default; the UI can still show a single row when there is only one.

**Layout files stay on disk, and we store references — never blobs.** Three reasons,
and the first is decisive: **the agent edits them with its own Read/Edit tools**, so
they must be real paths inside the directory we hand to ACP as `cwd`. Beyond that,
users keep layouts in git, and AL projects already contain them. The store holds the
path, the metadata and render history. It never owns the bytes.

**Report identity is per-client, presentation is global.** Report `61206` is only the
same report across two clients if both have the same extension installed. Base-app
reports (`1306` Standard Sales Invoice) genuinely are shared. So key layouts on
`(client, reportId)` and *group* by `reportId` in the UI — but let a report carry which
extension it came from, and do not assume two clients' `61206` have the same dataset
schema. If they diverge, the layouts are not interchangeable and the UI should not imply
they are.

## 3. Authentication: one app registration, many tenants

Your plan — shared client ID and secret, per-client tenant — means a **multi-tenant
Entra ID app registration**. The existing `AADOAuthBuilder` already builds a per-tenant
token URL, so the shape is right:

```
https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
```

Same `client_id` + `client_secret`, different `tenantId` → a token for that tenant.

**The operational catch, which is not a code problem:** client-credentials against
another tenant only works after that tenant has onboarded your app. For Business Central
that is two steps *in each client's tenant*:

1. **Admin consent** to your multi-tenant app registration.
2. **Register the app inside BC itself** — the *Microsoft Entra Applications* page —
   with the client ID, a state of Enabled, and permission sets granting API access.

Until both are done every call returns 401 with an unhelpful body. This belongs in
onboarding as an explicit, checkable step with a "Test connection" button, not as
something a user discovers through failure. Budget UI for it: a per-connection status
of *not consented / not registered in BC / no permissions / OK*.

### Rewriting the token cache

The current `AADOAuthBuilder` holds one token for one tenant and — as noted in
[tech-stack.md](./tech-stack.md#3-what-survives-from-rdl_previewer) — never actually
refreshes it. Multi-tenant forces a rewrite anyway, so fix both at once:

```ts
type Credentials = { clientId: string; clientSecret: string; scope: string };

export class TokenCache {
  #tokens = new Map<string, { token: string; expiresAt: number }>();
  #inflight = new Map<string, Promise<string>>();

  constructor(private creds: Credentials) {}

  async get(tenantId: string): Promise<string> {
    const hit = this.#tokens.get(tenantId);
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;   // 60s skew

    // Ten layouts for one client rendering at once must cause ONE token call.
    const pending = this.#inflight.get(tenantId);
    if (pending) return pending;

    const p = this.#fetch(tenantId).finally(() => this.#inflight.delete(tenantId));
    this.#inflight.set(tenantId, p);
    return p;
  }

  async #fetch(tenantId: string): Promise<string> {
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        grant_type: "client_credentials",
        scope: this.creds.scope,
      }),
    });
    if (!res.ok) throw new BcAuthError(tenantId, res.status, await res.text());

    const { access_token, expires_in } = await res.json() as
      { access_token: string; expires_in: number };
    this.#tokens.set(tenantId, {
      token: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    });
    return access_token;
  }
}
```

Four changes from the original, each fixing something real:

- **Keyed by tenant** — the whole point.
- **Uses `expires_in` from the response** instead of decoding the JWT. This drops the
  `jwt-decode` dependency entirely, and it is more correct: we cache what the issuer
  told us rather than re-deriving it.
- **Collapses concurrent misses.** Rendering a client's ten layouts at once currently
  fires ten identical token requests.
- **Throws on failure.** The original does `(await res.json()).access_token` with no
  status check; an error response yields `undefined`, which is then cached as "no token"
  and silently refetched forever with no diagnostic.

Store the **secret in the OS keychain**, never in the SQLite file and never in
`confidential.json`. One shared secret compromises every client tenant at once, so this
is the highest-consequence secret in the product.

### Build the URL, don't store it

`rdl_preview_config.json` stores `previewRdlApiFullUrl` fully expanded, which cannot
work once tenant/environment/company vary. Compose it:

```ts
const odataUrl = (c: Connection, action: string) =>
  `https://api.businesscentral.dynamics.com/v2.0/${c.tenantId}/${c.environment}` +
  `/ODataV4/${action}?company=${encodeURIComponent(`'${c.company.replaceAll("'", "''")}'`)}`;
```

Note the two escaping steps the hand-written URL got away with: OData string literals
double their apostrophes (`O'Brien` → `'O''Brien'`), and the result still needs URI
encoding. `HAWKS MIDDLE EAST` survives naively because it only contains spaces; the
first client with an apostrophe or `&` in the company name would not.

## 4. What each singleton becomes

| `rdl_previewer` today | Becomes |
|---|---|
| `rdlpConfig` / `confidentialConfig` module imports | SQLite store + keychain, read per request |
| `AADOAuthBuilder` with one `accessToken` | `TokenCache` keyed by tenant |
| `previewRdlApiFullUrl` (stored, expanded) | composed from `Connection` |
| `watch("./")`, `filename === "Default.rdl"` | `WatchManager` over many roots → layout IDs |
| `./preview.pdf` | `renders/{layoutId}/{contentHash}.pdf` |
| one `serverWs` | `Map<layoutId, Set<WebSocket>>` |
| `console.error` on BC failure | structured error on the render record + pushed to UI + returned to the agent |
| `openUrlInDefaultBrowser` at startup | the desktop shell owns the window |
| implicit "one render at a time" | per-connection queue (§6) |

## 5. File watching — verified behaviour

I tested this on your machine (Bun 1.3.11, Linux) because the design depends on it:

- **`fs.watch(root, { recursive: true })` works**, and reports paths relative to the
  watch root (`a/b/nested.rdl`). One watcher per layout root, not one per file.
- **Caveat, found the hard way:** a file created in a *subdirectory that did not exist
  when the watch started* was missed. Pre-existing nested files are reported fine. My
  first test looked like recursive watch was broken on Linux; it was a race against
  watch setup. So: re-scan on directory-creation events, and do not assume a brand-new
  subtree is covered.

The manager keeps one watcher per distinct root directory (several layouts often share
one), maps the reported relative path back to layout IDs, and applies the arbitration
rules from
[agent-feedback-loop.md](./agent-feedback-loop.md#render-arbitration) — debounce,
content-hash dedupe, and suppression while the agent is writing.

## 6. Concurrency and throttling

The moment several clients are live, renders overlap. Two rules:

- **Serialize per connection, parallelize across connections.** BC throttles per
  environment, and a queue per `connectionId` keeps one client's bulk re-render from
  starving another's interactive loop. Confirm the current limits against Microsoft's
  BC API throttling docs before choosing a concurrency number — do not guess one.
- **Dedupe on content hash before queueing.** `hash(layoutBytes + paramsXml)` against
  the last successful render for that layout. Identical bytes must never cost a BC round
  trip. This matters more than it sounds: a watcher event, an agent tool call and a UI
  refresh can all request the same render within a second.

Surface the queue in the UI. "Rendering 3 of 7, Acme queued behind Hawks" is far better
than an app that appears frozen while BC thinks.

## 7. Storage

**`bun:sqlite`** — verified built into Bun 1.3.11, WAL enabled, no dependency. It is the
right choice over JSON files: concurrent readers, real constraints, and render history
you can query.

```sql
CREATE TABLE client (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE connection (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES client(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,               -- 'Production', 'Sandbox Dev3'
  tenant_id     TEXT NOT NULL,
  environment   TEXT NOT NULL,               -- 'Production' | 'Dev3'
  company       TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  last_ok_at    TEXT,
  last_status   TEXT                         -- ok | unconsented | not_registered | forbidden | …
);

CREATE TABLE report (
  id         TEXT PRIMARY KEY,
  report_id  INTEGER NOT NULL,               -- 61206
  name       TEXT NOT NULL,
  source     TEXT                            -- 'base' | extension name
);

CREATE TABLE layout (                        -- the report × client binding
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES report(id)     ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES client(id)     ON DELETE CASCADE,
  connection_id  TEXT          REFERENCES connection(id),
  kind           TEXT NOT NULL CHECK (kind IN ('rdl','docx')),
  file_path      TEXT NOT NULL,              -- absolute; user owns the file
  params_xml     TEXT,
  UNIQUE (report_id, client_id, file_path)
);

CREATE TABLE render (
  id            TEXT PRIMARY KEY,
  layout_id     TEXT NOT NULL REFERENCES layout(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,               -- layout bytes + params
  pdf_path      TEXT,
  ok            INTEGER NOT NULL,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_render_dedupe ON render(layout_id, content_hash);
```

`idx_render_dedupe` is what makes §6's hash check a single indexed lookup, and
`duration_ms` quietly answers the open question about BC round-trip latency once real
usage accumulates.

Credentials get their own row (client ID, scope, grant type) with **the secret in the
keychain only**.

## 8. Screens

**Home — Reports.** One card per report: ID, name, client count, layout count, and the
aggregate health of the last render per client. Primary action: *Add report*.

**Report detail.** The clients-and-layouts table sketched in §2. Row actions: preview,
open agent session, edit params, switch connection. Adding a client to a report is the
core gesture of the app — it is how "Acme wants Hawks' invoice layout" becomes real, so
support *duplicate an existing client's layout as the starting point*.

**Client detail (secondary projection).** The same rows pivoted: every report this
client has a layout for, plus their connections and connection health. A consultant
onboarding a client thinks this way, and it costs one query.

**Settings.** Shared credentials (client ID, scope; secret write-only into the
keychain), then connections grouped by client with a *Test connection* button per row
that does a real token fetch plus a trivial OData call and reports the specific failure
from §3.

## 9. Migrating the existing config

Direct mapping, worth shipping as a one-time import so your current setup survives:

| Existing | Goes to |
|---|---|
| `bcClientId`, `bcClientSecret`, `bcClientScope`, `bcClientGrantType` | shared credentials + keychain |
| `bcTenantId` | `connection.tenant_id` |
| `Dev3` and `'HAWKS MIDDLE EAST'` (parsed out of `previewRdlApiFullUrl`) | `connection.environment`, `connection.company` |
| `reportId: 61206` | `report.report_id` |
| `reportParamsXml` | `layout.params_xml` |
| `./Default.rdl` | `layout.file_path` |

## 10. Open questions

1. **Is a "client" ever more than one tenant?** Groups with several BC tenants under one
   commercial customer would make Client → Tenant 1:N and change the settings UI.
2. **Do two clients ever share a layout file?** If you maintain one master template
   deployed to many clients, the model needs a shared layout with per-client overrides —
   materially more complex than the copy-per-client assumed here. Worth answering before
   building, because retrofitting it is expensive.
3. **Where do layout files live by default?** One app-managed workspace directory, or
   wherever the user's AL project already has them? The latter is friendlier and makes
   the ACP `cwd` obvious, but complicates backup and "add report" onboarding.
4. **What are BC's current API throttling limits** for this endpoint? Determines the
   per-connection concurrency in §6.
5. **Does the preview action need company at all** for every report, or only for
   company-scoped data? Affects whether company belongs on Connection or on Layout.
