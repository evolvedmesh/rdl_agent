# RDL Agent

Agentic RDL and DOCX report layout manipulation. Supports Claude Code, Codex, Github Copilot and opencode + other ACP supported agents

Point it at an `.rdl` or `.docx` you own, render it against real company data, and either
edit it yourself with live preview or hand it to an agent that can read the result as
text, geometry and pixels, and trace anything on the page back to the element that drew
it.

---

## Requirements

|                               |                                                                          |
| ----------------------------- | ------------------------------------------------------------------------ |
| **Bun**                       | 1.4+                                                                     |
| **poppler**                   | `pdftotext`, `pdftoppm`, `pdfinfo`                                       |
| **ImageMagick**               | `magick`                                                                 |
| **OS keychain**               | libsecret (`secret-tool`) on Linux, Keychain on macOS                    |
| **An ACP agent** *(optional)* | Claude Code, GitHub Copilot CLI, Gemini CLI, Codex, opencode             |
| **Business Central**          | the Pinetworks Base Application, with the `PINLayoutPreview` web service |

```bash
bun install
bun run test      # 106 tests, offline — no tenant needed
bun run desktop   # the app
```

---

## First run

Nothing is configured on a fresh install, and the home screen walks the same four steps.
Order matters.

### 1 · Shared credentials

**Settings → Shared credentials.** One multi-tenant Entra app registration serves every
client: the same client ID and secret, a different tenant per connection.

The secret goes to your OS keychain. It is never written to the database, never logged,
and never read back into the screen — the field only ever writes.

### 2 · A client, and a connection

**Settings → Add client**, then **Add connection** on that client's card.

A *client* is a customer organisation. A *connection* is one reachable BC target for
them: tenant ID, environment, company.

> **Company must match Business Central exactly** — case, spacing and punctuation. It
> goes into the OData URL as a string literal. The app handles apostrophe-doubling and
> URI encoding; it cannot handle a typo.

Then press **Test connection**. It fetches a token and calls BC, and tells you which of
the two onboarding steps is missing:

| Result                   | What to do                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **OK**                   | ready                                                                                              |
| **not consented**        | grant admin consent to the app registration in that tenant                                         |
| **not registered in BC** | add the client ID on BC's *Microsoft Entra Applications* page, state Enabled, with permission sets |
| **no permissions**       | the registration exists but lacks API access                                                       |
| **unreachable**          | network, or a wrong environment name                                                               |

Both consent and BC registration are required, and both fail with a bare 401 — which is
why this button exists.

### 3 · A report

**Reports → Add report.** The BC object ID and a name, e.g. `61206` / *Calc. and Post VAT
Settlement*.

### 4 · A layout

**Report → Add layout.** Choose the report, the client and the connection, then give an
absolute path to the layout file and its preview parameters.

> **Point this at a working copy.** The agent edits the file in place. Don't aim it at a
> pristine original you want to keep. `.docx` is detected from the extension.

#### About `reportParamsXml`

Business Central will not render without it, and it is the awkward part of setup: ~900
characters of `Options` and `DataItems` that name **real records** — document numbers,
G/L accounts, date ranges. That makes it per *client*, not per report; another tenant has
no such records and will render empty or error.

Fetch it rather than writing it. **Fetch from BC** on the params field lists every setting
saved for that report in the connection's company — name and owner — and drops the chosen
one's XML into the field. To create settings: in BC, **Report Settings → New**, which asks
for a name and then opens the report's own request page. For a report nobody has saved
settings for, **Report Parameters for Layout Preview** (page 60799 in the Pinetworks Base
Application) opens that same request page and hands back the XML to copy or download. A
layout without it is flagged **no params** in the table.

---

## Using it

### Reports

One card per report: ID, name, how many clients have a layout, and the health of the last
render for each. The header shows accumulated BC render latency (p50 / p95) once you have
rendered a few times — that number answers *"is the interactive loop viable"* from your
own usage rather than a guess.

### Report detail · Client detail

The same table, pivoted. A report shows its clients; a client shows its reports. Select a
row and its last render appears on the right.

Row actions:

|               |                                                                                     |
| ------------- | ----------------------------------------------------------------------------------- |
| **Render**    | send this layout to BC now                                                          |
| **Agent**     | start an agent session on it                                                        |
| **Params**    | fetch or edit `reportParamsXml`, or switch connection                               |
| **Duplicate** | copy this layout to another client — how *"Acme wants Hawks' invoice"* becomes real |

Edit the file in your editor and the preview re-renders a few seconds after you stop
changing it — the watcher waits for the file to settle, then renders once. Identical bytes
never cost a BC round trip.

### The preview

Page navigation and 75–200% zoom. Zooming re-renders at a higher DPI rather than scaling a
bitmap, so it gets genuinely sharper, not bigger.

### Agent sessions

Press **Agent** on a layout row. The app finds your installed CLI — no API keys, it reuses
your existing login — and opens a session with the layout's directory as the working
directory, so the agent cannot reach another client's files.

The session view shows the conversation, the agent's plan, its tool calls, live token and
cost, and the rendered page beside it. A few things worth knowing:

- **You approve writes.** Reads and the app's own tools are allowed silently; anything
  that changes a layout file stops and asks.
- **Hot reload.** The agent's edits refresh the preview the same way a manual save does —
  it does not have to remember to render. `layout_render` is still how it gets the full
  feedback bundle (lint, text, geometry diff) back; an unchanged file returns the last
  render for free.
- **Compare with first.** At the end of a session you can flip between the first and
  latest render, so *you* judge the result rather than the agent grading its own work.
- **Chats persist.** Close the app and the conversation, plan and cost are still there on
  the next launch. Reopen it from the sidebar and press **Resume** to keep going — the
  agent picks the session back up where a provider supports it, otherwise start a fresh
  one and the transcript stays for reference.

The agent works cheapest-first: it lints the XML for free, reads the page as text, diffs
the geometry against the previous render, and only then looks at pixels. It can also ask
where something on the page came from and get back `Default.rdl:1337`, with the column and
its declared width.

---

## Command line

Everything the UI does, without it. Useful for scripting, and for setting up several
clients at once.

```bash
bun apps/cli/src/index.ts <command>
```

| Command                                                                                                                     |                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `onboard --client <name> --tenant <guid> --environment <env> --company <co> --report <n> --layout <file> [--params <file>]` | client + connection + report + layout in one go            |
| `credentials --client-id <guid> --secret-stdin`                                                                             | shared credentials; secret read from **stdin**, never argv |
| `test-connection [--client <name>]`                                                                                         | token + a real BC call, with the specific failure          |
| `list`                                                                                                                      | every client × report layout, with last-render health      |
| `render --client <name> --report <n> [--force]`                                                                             | render headlessly                                          |
| `stats`                                                                                                                     | accumulated BC render latency                              |
| `import --preview <json> --layout <rdl> --client <name> [--confidential <json>]`                                            | migrate the old single-tenant previewer config             |

```bash
printf '%s' "$SECRET" | bun apps/cli/src/index.ts credentials --client-id <guid> --secret-stdin
```

Secrets go through stdin because argv lands in shell history and the process list, and
this one secret unlocks every client tenant.

---

## Trying it without Business Central

The whole app runs against a recorded response — no tenant, no secret, no load on
anyone's environment:

```bash
RDLA_FAKE_BC=/path/to/any.pdf RDLA_FAKE_LATENCY_MS=2000 bun run desktop
```

The sidebar shows **replay mode** so you cannot mistake it for the real thing. It returns
the fixture whatever the layout says, so it exercises the app, never a layout's
correctness.

---

## Building a standalone binary

`bun run build` compiles the whole app — core, server, GPUI UI, MCP shim — into **one
executable** with no Bun, `node_modules`, or source tree needed to run it.

| Script                                                                | Output                                           |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| `bun run build`                                                       | `dist/layout-agent` for the machine you build on |
| `bun run build:linux-x64` · `build:macos-arm64` · `build:windows-x64` | one per GPUIX target                             |
| `bun run build:all`                                                   | all three                                        |

The one binary is every entrypoint:

|                                                  |                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `./layout-agent`                                 | the desktop app                                                                                                               |
| `./layout-agent serve`                           | headless core — a browser drives it over localhost                                                                            |
| `./layout-agent mcp-shim --stdio --session <id>` | the per-session MCP proxy; the agent spawns this by re-executing the binary, so **agent sessions work in the packaged build** |

**Two things it still needs from the system:**

- **poppler-utils + ImageMagick** (`pdfinfo`, `pdftotext`, `pdftoppm`, `magick`) for the
  PDF text / raster / geometry feedback. Found on `PATH`, or in a `bin/` folder next to
  the binary, or wherever `$LAYOUT_TOOLS_DIR` points. Both are heavily dynamically linked,
  so embedding them is a platform-packaging job, not a build flag — ship them in the same
  archive if you need a zero-dependency drop.
- **An ACP agent CLI** (Claude Code, opencode, …) for agent sessions, same as running from
  source — it reuses your existing login.

GPUIX's native module ships as a separate binary per platform and Bun only embeds the one
it can resolve at build time, so `build:macos-arm64` / `build:windows-x64` produce a
loadable binary only when run on that OS (or a CI runner with that platform's
`@gpuix/native-*`). From the wrong host they exit 0 but can't open a window — run
`build:all` as a CI matrix, one leg per OS.

`.github/workflows/build.yml` does exactly that: on a `v*` tag (or manual dispatch) it
builds all three on their native runners, vendors poppler + ImageMagick with their
libraries into each bundle's `bin/`, smoke-tests the result, and attaches the archives to
a GitHub Release.

---

## Roadmap

| Phase                                                                                           | State                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **1 · Core engine** — store, keychain, tokens, render engine, watcher                           | ✅ done                                                |
| **2 · Feedback + tools** — lint, text, diff, raster, locate, MCP                                | ✅ done                                                |
| **3 · Agent integration** — one ACP client for every provider, sessions persisted and resumable | ⚠️ built; tested against a mock, never a live provider |
| **4 · UI** — reports, detail, settings, onboarding, session                                     | ✅ done                                                |
| **5 · Desktop shell** — GPUIX                                                                   | ✅ renders on Linux/Wayland/NVIDIA                     |
| **6 · Word layouts**                                                                            | ⚠️ renders; the docx *editing* tools are not built     |

### Next, in order

1. **Prove the loop converges.** The whole product rests on an agent being able to fix a
   layout from rendered feedback, and that has not been measured. Five realistic tasks are
   written up in [spikes/tasks/S2-tasks.md](spikes/tasks/S2-tasks.md) — widen a column,
   fix a wrap, bold the totals, move a field, add a logo. Half a day, and it can still
   invalidate the product.
2. **One live agent session.** The ACP client is proven against a mock agent only.
3. **Ship the AL.** `app/src/ReportLayoutPreview/` and `app/ws.xml` are built and
   analyzer-clean but uncommitted in the Base Application repo. Nothing renders on a
   tenant without them.

### Known gaps

- **The file chooser is the desktop's, not the app's.** Browse hands off to Finder,
  the Windows common dialog, or a portal-backed helper (zenity / kdialog) on Linux. On a
  box with none of those installed, the path is still typed.
- **Session resume is mock-tested only.** Chats persist and rebuild across a restart, and
  `Resume` calls ACP `session/load` — but the only agent it has run against is the test
  fixture, same caveat as the rest of Phase 3.
- **Text fields miss some OS editing keys.** GPUIX's native input binds word operations to
  the macOS `cmd-*` chords; Ctrl/Alt+Backspace is polyfilled in the app, but only for a
  caret at the end of the field. Word navigation and select-all need the fix upstream.
- **Multi-page geometry diffing compares pages by index**, so an inserted page reports the
  whole document as changed. The diff says so rather than hiding it.
- **Render history has no UI**, though it is stored and served.
- **Packaging stops at the binary.** `bun run build` produces one self-contained
  executable (see *Building*), but there's no installer, icon, code-signing or updater,
  and poppler / ImageMagick are still expected on the system rather than bundled.
- **One window.** GPUIX is single-window, so the preview cannot be detached to a second
  monitor.

### Open question

**Do two clients ever share one layout file?** The schema assumes each client owns its own
copy. Master templates with per-client overrides would change the store, the render queue
and the UI — much cheaper to answer now than to migrate later.

---

## Further reading

- [docs/architecture.md](docs/architecture.md) — how it works, and why
- [docs/implementation-plan.md](docs/implementation-plan.md) — the build plan
- [AGENTS.md](AGENTS.md) — working on this codebase, human or model
