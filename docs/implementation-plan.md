# Implementation Plan

Derived from the four research documents in this folder. Read those first; this one only
sequences the work and says what to build in what order, and why that order.

## Guiding principles

Five decisions from the research that this plan treats as settled:

1. **One provider integration, via ACP.** Not four CLI adapters.
   → [tech-stack.md §1](./tech-stack.md#1-provider-integration-use-acp-dont-write-four-cli-adapters)
2. **The core is a Bun process; the UI talks to it over localhost.** The desktop shell
   is a late-bound decision, not a foundation.
   → [tech-stack.md §2](./tech-stack.md#recommendation-make-the-shell-a-late-bound-decision)
3. **Feedback is a ladder, cheapest first**: BC error → lint → layout text → geometry
   diff → trimmed pixels. → [agent-feedback-loop.md](./agent-feedback-loop.md)
4. **Everything is multi-client from the first line of code.** Retrofitting
   multi-tenancy is far more expensive than starting with it.
   → [report-projects.md](./report-projects.md)
5. **Compose existing tools.** We do not write a PDF renderer, a docx editor, or an
   agent harness. → [docx-layouts.md §4](./docx-layouts.md#4-recommended-architecture-compose-dont-rebuild)

And one principle about the plan itself:

> **Validate the product hypothesis before building the product.** The bet is that *an
> agent can iteratively fix a report layout from rendered feedback*. That is testable in
> days, with no UI and no desktop shell, using an agent CLI you already have installed.
> Everything else is engineering around an assumption that is either true or fatal.

## Phase 0 — De-risking spikes

Five questions whose answers change the plan. Each is timeboxed with an explicit
kill/redirect criterion. Do not start Phase 1 until S1–S3 are answered.

| # | Question | Method | Box | If it fails |
|---|---|---|---|---|
| **S1** | What is BC's render latency and throttle ceiling? | Loop the existing previewer's call 20× against Dev3; record p50/p95. Then burst to find the 429. | 0.5d | p95 > ~20s ⇒ the interactive loop premise dies; UX becomes async/batch. Replan Phase 4. |
| **S2** | **Does the agent loop converge?** | Throwaway MCP server (render + text + trimmed image, ~200 lines) attached to Claude Code. Five real tasks: widen a column, bold the totals, fix a wrap, move a field, add a logo. Count iterations and tokens per task. | 2d | Can't do simple tasks in <10 iterations ⇒ **stop and rethink the product**, not the code. |
| **S3** | Does ACP deliver what it advertises? | Minimal JSON-RPC client over stdio. Drive `copilot --acp` and `claude-agent-acp`: `initialize` (check `promptCapabilities.image`, `mcpCapabilities.http`), `session/new` **with an mcpServers entry**, one prompt turn, one permission request. | 1.5d | MCP passthrough doesn't work ⇒ fall back to per-CLI adapters. Large cost; know it now. |
| **S4** | Which shell survives your hardware? | Electrobun hello-world with a pdf.js pane under Hyprland+NVIDIA. GPUIX window with an `<img>` page pane and a sibling scroll pane. | 1d | Both fail ⇒ ship as a local web app; revisit later. |
| **S5** | Can BC render a *supplied* docx transiently? | AL spike against `Report.SaveAs` with a layout record. | 1d | Must persist as a tenant layout ⇒ docx preview has side effects; needs cleanup design. Gates Phase 6 only. |

**S2 is the one that matters.** It is cheap, it uses the previewer as it stands today,
and it is the only spike that can invalidate the whole product. Do it first.

A sixth, not blocking but do it early: **onboard one real second tenant** (admin consent
+ BC Entra Applications registration) and time it. That number is the true cost of
adding a client, and it is a product constraint, not a technical one
([report-projects.md §3](./report-projects.md#3-authentication-one-app-registration-many-tenants)).

## Repository shape

A Bun workspace. The boundaries matter more than the names — each package below must be
usable without the ones beneath it in the list.

```
packages/
  core/       store (bun:sqlite) · credentials · TokenCache · Connection · RenderEngine · WatchManager
  feedback/   PDF → lint · layout text · bbox geometry diff · trimmed raster · locate
  layout/     format adapters:  rdl/  (XML)   docx/ (OOXML, content controls)
  mcp/        MCP server exposing the layout_* tools  (stdio + localhost HTTP)
  acp/        ACP client: process mgmt · JSON-RPC · capabilities · sessions · permissions
  server/     Bun HTTP + WebSocket: REST for the UI, session routing, static assets
  ui/         React app — shell-agnostic, runs in a plain browser
apps/
  cli/        headless render + `layout-mcp --stdio`   (ships in Phase 1–2)
  desktop/    the chosen shell                          (deferred to Phase 5)
```

**Rename now.** `rdl_agent` and `rdl_*` stop fitting the moment docx lands
([docx-layouts.md §7](./docx-layouts.md#7-consequences-for-the-product)). Pick the name
in Phase 1 while it costs nothing. Tools are `layout_*` throughout.

## Phase 1 — Core engine (no UI, no agent)

**Goal:** render any client's layout from the command line.

1. **Store.** The schema in
   [report-projects.md §7](./report-projects.md#7-storage) via `bun:sqlite` (verified
   built in, WAL works). Migrations from day one.
2. **Credentials.** Shared client ID + scope in the store; **secret in the OS keychain
   only**. One shared secret compromises every client tenant — treat it accordingly.
3. **`TokenCache`.** Per-tenant, `expires_in`-based, in-flight collapsing, throws on
   failure. Full sketch in
   [report-projects.md §3](./report-projects.md#rewriting-the-token-cache). Drops the
   `jwt-decode` dependency.
4. **Connection + URL builder.** Composed, never stored expanded. OData apostrophe
   doubling *and* URI encoding.
5. **`RenderEngine`.** `render(layoutId) → RenderResult`. Per-connection serial queue,
   parallel across connections, content-hash dedupe before queueing, every failure
   captured as a structured error rather than a log line.
6. **`WatchManager`.** One recursive watcher per layout root (verified working on Bun
   1.3.11/Linux), re-scanning on directory creation
   ([report-projects.md §5](./report-projects.md#5-file-watching--verified-behaviour)).
   Debounce + hash dedupe + suppression while an agent writes.
7. **Import** the existing `rdl_preview_config.json` / `confidential.json`
   ([report-projects.md §9](./report-projects.md#9-migrating-the-existing-config)).

**The contract everything downstream depends on.** Get this right once:

```ts
type RenderResult =
  | { ok: true;  layoutId: string; pdfPath: string; pageCount: number;
      contentHash: string; durationMs: number; lint: LintFinding[] }
  | { ok: false; layoutId: string; error: BcError; durationMs: number };

type BcError =
  | { kind: "auth";     tenantId: string; status: number; detail: string }
  | { kind: "consent";  tenantId: string }            // not consented / not registered in BC
  | { kind: "throttle"; retryAfterMs: number }
  | { kind: "render";   bcMessage: string }           // the layout itself failed — the useful one
  | { kind: "network";  detail: string };
```

`kind: "render"` carrying BC's own message is the single highest-value signal in the
system, and the current previewer throws it into `console.error`.

**Done when:** `layout render --client hawks --report 61206` produces a PDF, and the
same command for a second client against a second tenant also works.

*Rough size: 5–8 days.*

## Phase 2 — Feedback pipeline + MCP surface ← the product gate

**Goal:** any agent CLI can drive a layout to a target design. No UI yet.

1. **`feedback/`** — the ladder, in cost order:
   - `lint()` — deterministic, zero-token. Body width + margins > page width (the blank
     alternate-page bug, catchable from XML *before* rendering), page-count change,
     elements crossing margins, overlaps.
   - `text()` — `pdftotext -layout`, ~500 tokens.
   - `diff()` — parse `pdftotext -bbox-layout`, compare to the previous render **in
     code**, emit only deltas. Never ship the 25,900-char raw form.
   - `pageImage()` — `pdftoppm` then **trim to content** (~726 tokens at 150 dpi vs
     ~2,902 untrimmed). Keep pre-trim offsets so pixels map back to page coordinates.
     Support `region` for zooming instead of resending a page.
   - `locate()` — page coordinate or text → the layout element that produced it, with
     `file:line`. **Build this properly**; it is what makes the loop converge instead of
     grep-and-guess.
2. **`mcp/`** — `layout_render`, `layout_page_image`, `layout_text`, `layout_diff`,
   `layout_lint`, `layout_locate`, `layout_params`. Deliberately **no file read/write
   tools** — the agent's own Read/Edit already cover the RDL XML.
   stdio transport first (mandatory for all ACP agents); localhost HTTP second, so the
   app and the agent share one render.
3. **Loop control** — iteration cap, images-per-iteration cap, and require the agent to
   state its expected change before each render
   ([agent-feedback-loop.md](./agent-feedback-loop.md#convergence-control)).

> **Decision gate.** Attach this to Claude Code and run the S2 task set again, properly
> this time. If a competent agent cannot reliably make five realistic layout changes,
> the UI will not save it. Everything after this phase assumes this gate passed.

*Rough size: 6–9 days.*

## Phase 3 — ACP client

**Goal:** the same loop, driven by any provider, from our process.

1. **Provider registry + detection** — find installed CLIs, map to launch commands
   ([tech-stack.md §1](./tech-stack.md#the-finding)). "We found Claude Code and Copilot"
   beats an API-key form.
2. **JSON-RPC over stdio**, process lifecycle, crash and restart handling.
3. **`initialize`** — negotiate and *store* per-provider capabilities. Three flags drive
   real behaviour: `promptCapabilities.image`, `mcpCapabilities.http`, `loadSession`.
   Degrade to text-only feedback where images aren't accepted.
4. **`session/new`** with `cwd` = the layout's directory and our MCP server in
   `mcpServers`.
5. **`session/update` fan-out** → the UI event stream: message chunks, tool calls, plan,
   token/cost usage.
6. **`session/request_permission`** → a UI prompt, with a policy layer (auto-allow reads
   and our own `layout_*` tools; always ask before writing a layout file).
7. **Path confinement** — the agent's `cwd` is one layout directory. Do not hand it the
   whole workspace.

*Rough size: 6–8 days.*

## Phase 4 — UI (browser-hosted)

**Goal:** the app, running at `localhost` in a browser. No shell yet.

Screens per [report-projects.md §8](./report-projects.md#8-screens):

- **Home — reports.** Cards: ID, name, client count, layout count, last-render health.
- **Report detail.** Clients × layouts table. Row actions: preview, start agent session,
  edit params, switch connection. *Duplicate another client's layout* is the core
  gesture — it is how "Acme wants Hawks' invoice" becomes real.
- **Client detail.** Same rows pivoted, plus connection health. One query, and it is how
  a consultant actually thinks.
- **Settings.** Shared credentials (secret write-only to keychain); connections grouped
  by client with a real **Test connection** that reports the specific failure —
  *not consented / not registered in BC / no permissions / OK*.
- **Session view.** Chat, streamed tool calls, the agent's plan, live token+cost, a
  permission prompt, and the PDF pane side by side. Show the render queue: *"Rendering 3
  of 7, Acme queued behind Hawks"* beats an app that looks frozen.

Two things the research says to build here specifically: the **first/last visual
comparison** at session end so the human judges the result rather than the agent grading
itself, and **per-connection queue visibility**.

*Rough size: 10–14 days.*

## Phase 5 — Desktop shell

Decided by S4, not now. Package the Phase 1–4 core unchanged behind whichever shell
survived; wire the OS keychain and an updater. If both shells disappointed, shipping the
local web app is a legitimate outcome — nothing above depends on the choice.

*Rough size: 4–7 days.*

## Phase 6 — Word layouts

Gated on S5.

1. **AL:** extend the endpoint with `wordLayoutAsBase64` (or a layout-kind parameter).
2. **`bc-layout-mcp`** — the binding-aware tools that no existing server provides:
   `layout_schema`, `layout_controls`, `layout_bind_check`, `layout_field_style`
   ([docx-layouts.md §4](./docx-layouts.md#what-bc-layout-mcp-must-expose)).
   `layout_bind_check` runs after every edit, before spending a BC render.
3. **Compose a third-party server** for generic OOXML work — safe-docx (Apache-2.0,
   Node, easy to bundle) or docx-mcp (MIT, raw OOXML, richer). **Vendor and pin it**;
   do not require `npx`/`uvx` at runtime on a user's machine. **Curate the toolset** —
   200+ generic tools will drown the agent and invite unbound-paragraph mistakes.
4. **Default docx edits to tracked changes.** Native Word review of agent edits is a
   real feature RDL cannot offer.
5. **Optional fast local loop:** `soffice --headless --convert-to pdf` for pure styling
   iteration (not installed on your machine). LibreOffice rendering ≠ Word ≠ BC — fast
   feedback only; BC stays the authority.

*Rough size: 8–12 days.*

## Cross-cutting, from day one

**Security.** Shared secret in the keychain, never in SQLite or a JSON file. Agent
confined to one layout directory. Writes to layout files always require permission.
Never log tokens or `reportParamsXml` (it contains customer data).

**Errors.** The `BcError` taxonomy above, surfaced three ways from one source: structured
tool error to the agent, a specific message in the UI, a row in `render`.

**Testing.** Unit-test the feedback pipeline against checked-in PDF fixtures — it is pure
and the highest-value thing to lock down. Record real BC responses once and replay them;
do not hit a live tenant in CI. Note GPUIX has no headless test renderer on Linux, so UI
tests, if any, run on macOS/Windows CI.

**Observability.** `render.duration_ms` accumulates the BC-latency answer over real use.
Track tokens per completed layout change — it is the number that tells you whether the
loop is economic.

## Explicitly not building

Naming these prevents scope drift: no cloud sync or multi-user server; no BC *dataset* /
AL editing (layouts only); no visual drag-and-drop layout designer; no API-key
management (ACP reuses CLI logins); no PDF renderer, docx editor, or agent harness of
our own.

## Decision gates

| Gate | Question | Consequence |
|---|---|---|
| After S1 | BC latency acceptable? | Sets whether the UX is interactive or async |
| After S2 | **Does the loop converge?** | **Go / no-go on the product** |
| After S3 | Does ACP + MCP passthrough work? | Single client, or four adapters |
| After Phase 2 | Can an agent CLI drive a real change end to end? | Go / no-go on building UI |
| After S4 | Which shell? | Phase 5 scope |
| After S5 | Transient docx render? | Phase 6 scope, or docx has side effects |

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **The AL extension is the whole product** and no other tenant has it | Critical | Not a code problem. Decide distribution before Phase 4. |
| The loop doesn't converge | Critical | S2, before anything else |
| BC too slow or throttles hard | High | S1; per-connection queue; hash dedupe; local docx loop |
| `reportParamsXml` is unauthorable by users | High | **Addressed**: Fetch from BC reads saved settings over OData; Base Application page 60799 captures new ones from the request page |
| Multi-tenant consent friction per client | High | Time it on a real second tenant; build the status UI |
| ACP adapters drift across provider releases | Medium | Pin adapter versions; capability negotiation already degrades gracefully |
| Shell framework immaturity | Medium | Late-bound by design; web app is a valid fallback |
| Shared layout files across clients | Medium | **Answer question 2 in the README before Phase 1** — expensive to retrofit |
| Generic docx servers blind to content controls | Medium | Measured and understood; `bc-layout-mcp` covers it |

## Suggested order

```
S2 ─────────────► S1 ─► S3 ─────────► Phase 1 ─► Phase 2 ─►│gate│─► Phase 3 ─► Phase 4 ─► Phase 5
(converge?)     (speed) (ACP)          core       MCP+loop         ACP         UI         shell
                                    S4 ───────────────────────────────┘ (any time before 5)
                                    S5 ──────────────────────────────────────────► Phase 6
```

Roughly 6–9 weeks of focused solo work to end of Phase 4, plus spikes. Treat the sizes as
relative weights, not commitments — S1 and S2 will move them.

## Before writing code, answer these

From the [README](./README.md), in the order they block work:

1. **Do two clients ever share one layout file?** Blocks the Phase 1 schema.
2. **Is the AL extension shippable to other tenants?** Blocks everything commercially.
3. **Who is the user** — BC developer or functional consultant? Shapes Phase 4.
4. **Is docx v1 or v2?** If v1, S5 moves into Phase 0 and the layout abstraction must be
   two-format from the start rather than RDL-first.
