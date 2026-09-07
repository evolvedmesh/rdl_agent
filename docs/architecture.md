# Architecture

How the app is put together, and why. The research that led here is in the four
documents beside this one; [implementation-plan.md](./implementation-plan.md) is the
build plan those produced.

## Shape

```
apps/desktop      GPUIX shell — React → GPUI → Vulkan. No webview.
apps/cli          headless render + the stdio MCP shim
      │  localhost HTTP + WebSocket
packages/server   REST, event stream, agent session orchestration
packages/acp      one ACP client for every provider
packages/mcp      the layout_* tool surface (stdio + HTTP)
packages/feedback PDF → lint · text · geometry diff · trimmed raster · locate
packages/core     store · credentials · tokens · render engine · watcher
```

Each package must stay usable without the ones above it. `apps/cli` renders a layout
with only `@layout/core`, and that is the check that the boundary actually holds — it is
also what keeps the desktop shell replaceable, which the plan treats as a late-bound
decision rather than a foundation.

The desktop app hosts the core process in-window rather than spawning a sidecar. On
Linux and Windows GPUI runs its blocking native event loop on a dedicated Rust UI
thread, so Bun's event loop stays free for the HTTP server, WebSocket, render engine,
ACP subprocesses and MCP server. The UI still talks to the core over localhost, so
nothing in the shell is load-bearing: a browser can drive the same server.

## The feedback ladder

Cheapest channel first; escalate only when the cheaper one cannot answer the question.
Measured on the sample report (report 61206, A4, one page):

| Channel | Cost | What it catches |
|---|---|---|
| BC error | ~50 tok | the layout failed, in BC's own words |
| `layout_lint` | **0** | body wider than page, overhang, overlap, malformed XML |
| `layout_text` | ~500 tok | truncation, wrapping, values, ordering |
| `layout_diff` | ~90 tok | what moved, in points, versus the previous render |
| `layout_locate` | **0** | rendered text or coordinate → the element, with `file:line` |
| `layout_page_image` | ~770 tok | alignment, borders, shading, weight — visual judgement only |

Trimming to content at 150 dpi costs ~770 tokens against ~2,900 untrimmed, and slightly
less than a full 72 dpi page while being twice as sharp. **Crop, don't downscale.**
`test/feedback.test.ts` asserts these relationships, so a regression in the raster path
fails the suite rather than quietly costing tokens.

### Why `locate` matters most

Seeing a defect is easy. Mapping it back to one of 120 textboxes across 4,139 lines of
XML is the step that otherwise dominates the iteration count, because without help an
agent greps and guesses.

The join is **geometric, not textual**. A tablix declares its column widths, so
cumulative widths give every column an x-range in page points, and a rendered word falls
in exactly one of them:

```
"SRICHAR" → Table1 column 10 (x 519–557pt, declared width 1.346cm)
            VATEntryUserID  Default.rdl:1337  =Fields!UserID_VATEntry.Value
```

String matching could never make that link: the RDL contains `=Fields!UserID_VATEntry.Value`
and the page shows `SRICHARAN`. It also diagnoses wraps — `"Credit Memo"` comes back as
*"Credit / Memo (wrapped across 2 lines)"* with the column that caused it.

Two bounds in there were bugs before they were features: the column match checks the
**y-axis** as well (a label above the table shares column 0's x-range and matched it with
full confidence), and the body origin includes the **page header height** (without it
every vertical comparison is off by ~45pt).

## Render arbitration

A render is triggered by any change to the layout file on disk — a human saving in their
editor, or the agent editing with its own Edit tool. Both hot-reload the preview; the
agent does not have to call `layout_render` for the page to update (it calls that to get
the feedback bundle — lint, text, geometry diff — back). Left alone this storms: an
editor emits several events per save, and an agent rewrites five textboxes in one turn.
So `WatchManager` owns three rules: **debounce hard (3s)**, so a whole burst collapses to
one render once the file goes quiet; **drop the event if the content hash is unchanged**;
and a short **suppression** held only for the duration of one explicit `layout_render`
call, so that render and the watcher's render of the same bytes don't both hit BC (the
engine's own content-hash dedupe is the backstop if they race).

`RenderEngine` serialises per connection and parallelises across them, because BC
throttles per environment and one client's bulk re-render must not starve another's
interactive loop. Queue depth is surfaced so the UI can say *"3 queued"* rather than
looking frozen. Content-hash dedupe happens **before** queueing: a watcher event, an
agent tool call and a UI refresh can all ask for the same render within a second.

## The error taxonomy

`BcError` is the contract the plan says to get right once, and the reason is that BC's
own message is the highest-value signal in the system — the original previewer threw it
into `console.error`.

| kind | means | surfaced as |
|---|---|---|
| `auth` | bad secret or token | Settings shows *no permissions* |
| `consent` | tenant has not onboarded the app | *not consented* / *not registered in BC* |
| `throttle` | 429/503, with `retryAfterMs` | queue backs off |
| `render` | **the layout failed** — carries BC's text verbatim | the agent's tool error |
| `network` | unreachable | *unreachable* |

Consent and BC registration are separate steps in a customer's tenant and both fail with
a bare 401, which is why *Test connection* distinguishes them explicitly.

## The BC side

The render API is AL, in a separate repo:
`al_dev/BaseApplication/app/src/ReportLayoutPreview/` — codeunit 60796
`PIN Layout Preview API`, published as the web service `PINLayoutPreview`.

It inserts the supplied layout as a transient `Tenant Report Layout` with a **null App
ID**, selects it through `Design-time Report Selection`, renders with `Report.SaveAs`,
then clears the selection and deletes the layout — on failure as well as success. A
preview leaves nothing behind and disturbs no layout a user has configured.

The ordering detail that matters: the design-time selection is **single-instance session
state**, so an `Error()` rolls back the layout record but *not* the selection. The render
sits inside a `[TryFunction]` so the clear is always reached.

**OData binds an unbound action's body onto the AL method by parameter name.** A rename
on either side fails at runtime with an unhelpful message, and no compiler spans the two
repos. Keep `previewRequestBody()` in `packages/core/src/bc.ts` as the single place the
body is built.

`LAYOUT_BC_LEGACY=1` switches back to the older `RdlpApi_PreviewRdl` action — it changes
the action name *and* the body shape together, since the old one takes
`rdlFileAsBase64` and no `layoutFormat`. Remove it once every tenant is upgraded.

## Running without a tenant

Every part of the app runs against a recorded BC response — no tenant, no secret, no
load on someone's environment. This is the plan's testing rule ("record real BC
responses once and replay them") built in from the start.

```bash
RDLA_FAKE_BC=/path/to/preview.pdf RDLA_FAKE_LATENCY_MS=2000 bun run desktop
RDLA_FAKE_BC=error:consent bun run desktop      # any BcError kind
```

It is **not** a renderer: it returns the fixture whatever the layout says, so it proves
the pipeline's mechanics, never a layout's correctness.

## What GPUIX actually does on this hardware

S4, answered empirically rather than from the docs. Everything below was found by
running it, and each has shaped the code:

- ✅ **Renders.** A real native Wayland window under Hyprland + NVIDIA, via Vulkan.
- ❌ **No automated UI testing on Linux.** The automation transport connects, but the
  renderer's `captureScreenshot`, `getAllText` and `getPaintedText` are all undefined.
  Screenshots are taken with `grim` against the compositor instead.
- ⚠️ `enableAutomation()` suppresses the visible window.
- ⚠️ **`<img src>` loads from the filesystem, not over HTTP.** The server hands the UI a
  *path* to the page raster (`/api/page-path/...`), not bytes.
- ⚠️ **A `<text>` takes exactly one string child.** Several children become separate runs
  that wrap between each other, so `{n} items` renders as two stacked lines. Every label
  is a single template literal.
- ⚠️ Centering a child wider than its scroller clips the leading edge and makes it
  unreachable by scrolling; the PDF pane uses `flex-start`.
- ⚠️ GPUI does not inherit colour — an uncoloured `<text>` paints black and vanishes.
- Nested scrolling is unsupported; panes are siblings, never nested.
- Single window only.

## Data model

`report-projects.md` §7 has the reasoning. The decision worth re-reading before it has
data to migrate: a layout is keyed `(report, client, file_path)`, so **each client owns
its own copy of a layout file**. Shared master templates with per-client overrides would
change the store, the render queue and the UI.

`paramsXml` lives on the **layout**, not the report, because it names real records in one
client's company. A report-level blob would render empty or error for every other client.
