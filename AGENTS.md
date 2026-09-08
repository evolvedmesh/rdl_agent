# Working on this codebase

For anyone — human or model — changing code here. [README.md](./README.md) is for people
*using* the app; [docs/architecture.md](docs/architecture.md) explains how it works and
why. This file is about how to work on it without breaking things.

Claude Code users: [CLAUDE.md](./CLAUDE.md) adds tool-specific notes on top of this.

---

## What this is

An agent-driven editor for Business Central report layouts. The premise: an agent can
iteratively fix a layout from *rendered* feedback — render the real report, read the page,
change the XML, render again.

Two halves, in two repos:

|                                     |                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **This repo**                       | the app — core engine, feedback pipeline, MCP tools, ACP client, server, Electrobun desktop UI                   |
| `~/projects/al_dev/BaseApplication` | the AL that renders a *supplied* layout: codeunit 60796 `PIN Layout Preview API`, web service `PINLayoutPreview` |

Nothing works without both. The AL is currently **built and analyzer-clean but
uncommitted**.

---

## Use CodeGraph first

This repo is indexed. Before grepping or opening files to understand something, ask:

```bash
codegraph explore "RenderEngine render dedupe"
codegraph explore "how does locate map text to an element"
```

One call returns the relevant symbols' verbatim line-numbered source, the call paths
between them, **which tests cover each symbol**, and a blast radius — who depends on what
you are about to change. That last part is the reason to reach for it before an edit, not
just when lost.

If an MCP tool `codegraph_explore` is available, prefer it; the shell command always
works. Treat returned source as already read — don't re-open those files.

---

## Commands

```bash
bun run test        # 117 tests, offline, ~6s
bun run typecheck   # tsc --noEmit across the workspace
bun run ui          # build the webview with Vite → apps/desktop/dist
bun run desktop     # the Electrobun app (builds the UI first)
bun run server      # core + UI over HTTP, no window — a browser can drive it
bun run build       # stable bundle + installer for this host → artifacts/
bun run build:dev   # runnable bundle, no distribution artifacts → build/
bun run build:canary # optimized prerelease channel, same shape as build
```

The app is one Electrobun bundle. Inside it, `<app>/bin/bun` is a real Bun runtime and
`<app>/Resources/app/bun/index.js` is the main process — which is why the two non-GUI
entrypoints still work with no extra files:

```bash
<bundled-bun> <index.js> serve                            # headless core
<bundled-bun> <index.js> mcp-shim --stdio --session <id>  # the per-session MCP proxy
```

`Session.mcpServerConfig()` builds exactly that from `process.execPath` + `Bun.main`.
Neither path loads the native window wrapper, so both run headless with no display.

The UI is built by **Vite, not by Hutch** — Hutch cannot serialise bundler plugins across
its config boundary and Tailwind needs one. `electrobun.config.ts` copies
`apps/desktop/dist` into `views/mainview`, and the app's own loopback server serves it, so
the UI and `/api` share an origin.

It still needs poppler + ImageMagick on the system. `resolveTool` in
`packages/feedback/src/bin.ts` looks on PATH, in a **`tools/`** folder beside the binary,
then `$LAYOUT_TOOLS_DIR`. Not `bin/` — inside a bundle that is Electrobun's own.

Hutch does not cross-compile: a full matrix means a native runner per target. On Linux the
bundle links **gtk3, webkit2gtk-4.1, libayatana-appindicator and librsvg** at runtime; the
launcher names the missing library if one is absent.

Run both `test` and `typecheck` before claiming anything works. The test suite needs no
tenant and no secret.

### Seeing the UI

The UI is a webview served over HTTP, so the fastest loop is a **real browser**:

```bash
LAYOUT_DATA_DIR=/tmp/scratch RDLA_FAKE_BC=$PWD/test/fixtures/preview.pdf \
  LAYOUT_PORT=7788 LAYOUT_NO_AUTH=1 bun apps/desktop/src/main.ts serve
# open http://127.0.0.1:7788/ and use devtools like any web app
```

That is also what makes the UI testable at all — Playwright drives the identical app.

For the real window, capture the compositor:

```bash
bun run desktop &
sleep 25
hyprctl clients -j | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    if c.get('title')=='Layout Agent': print(c['at'][0],c['at'][1],c['size'][0],c['size'][1])"
grim -g "<x>,<y> <w>x<h>" shot.png
```

**`WEBKIT_DISABLE_COMPOSITING_MODE=1` is not optional on this machine.** WebKitGTK's
accelerated compositing fails under XWayland here — `X11 Error: GLXBadWindow` — and the
webview then paints **nothing at all**, with no error in the app's own log. `bun run
desktop` sets it; a bare `hutch electrobun dev` does not. A blank window is almost
certainly this, not your code. It also means CSS animation is unaccelerated here, so do
not judge animation smoothness on this box.

**Look at the screenshot.** Several real bugs in this UI — wrapped labels, a clipped page,
a client name truncated to a single character — were invisible in code and obvious in a
picture.

---

## Rules

### Never call Business Central without being asked

Renders hit a real customer-adjacent tenant using a shared secret that unlocks *every*
client tenant. This got sharper with hot reload: during an agent session the file watcher
now re-renders on the agent's own edits (debounced 3s), so a session left running against
a real connection makes a live BC call every few seconds of editing. Develop against
replay mode; only point a session at a real tenant when you mean to.

Use replay mode:

```bash
RDLA_FAKE_BC=/path/to/preview.pdf RDLA_FAKE_LATENCY_MS=2000 bun run desktop
RDLA_FAKE_BC=error:consent ...     # or auth, throttle, render, network, reportmissing, badformat
```

The plan's testing rule is *record real BC responses once and replay them*. Latency is
~2s; simulate it, because a pipeline that feels fine at 0ms is unusable at 2s.

### Never touch the real keychain from a test

`defaultSecretStore()` finds your actual OS keyring. A test that saves credentials will
leave a secret there under this app's service name — this has already happened once. Pass
`new MemorySecretStore()` to `createApp({ secretStore })`. There is a test asserting the
suite never reaches the real store; keep it passing.

### Never log secrets or `reportParamsXml`

The params blob contains customer data — document numbers, G/L accounts, dates. Tokens and
the client secret never go to stdout, a log, or an error message.

### stdout is JSON-RPC in MCP servers

`packages/mcp/src/server.ts` and `apps/cli/src/mcp-shim.ts` speak JSON-RPC on stdout.
Anything else there corrupts the stream. Log to stderr.

---

## Package boundaries

```
apps/desktop  →  packages/server  →  packages/{acp,mcp}  →  packages/{core,feedback}
apps/cli      →  packages/core
```

Each package must stay usable without the ones to its left. `apps/cli` renders a layout
with **only** `@layout/core` — that is the check the boundary actually holds, and it is
what keeps the desktop shell replaceable. Don't import `@layout/server` from `core`, or
Electrobun from anything but `apps/desktop/src/main.ts`.

There is a second boundary inside `apps/desktop`, and it is easy to break silently:

```
apps/desktop/src/main.ts    the Bun main process — may import anything
apps/desktop/src/view/**    the webview — **types only** from @layout/*
```

The view runs in WebKit. Importing a *value* from `@layout/core` — even a three-line
formatter — makes the bundler follow that package's real module graph and pull
`bun:sqlite`, `node:fs` and `Bun.spawn` into a browser bundle. `vite.config.ts`
deliberately declares **no alias** for `@layout/*`, so a value import fails the build
loudly instead of quietly succeeding. Small shared helpers belong in
`apps/desktop/src/view/format.ts`.

---

## Webview rules

The UI is React 19 + Tailwind v4 in a system webview, served over HTTP by the app's own
loopback server. The old GPUIX rules are gone — the browser inherits colour, wraps text,
clips with ellipsis and has real portals. What replaced them:

| Rule                                                                     | What goes wrong                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Theme tokens are **named utilities** (`bg-panel`, `text-dim`)            | `bg-[--color-panel]` does not resolve in Tailwind v4 and silently does nothing                   |
| Panes use **container queries** (`@container` + `@2xl:`), not `compact:` | a pane in a split is unrelated to the viewport; media queries fold the wrong columns             |
| Never put a `flex-1` spacer beside a `flex-1` column                     | they split the free space and starve the column — this truncated a client name to `A…`           |
| Agent markdown goes through `Markdown.tsx`                               | it is model output rendered in a document holding an API token; `marked` alone is not a boundary |
| `<img src>` is an **HTTP URL** with the token (`api.pageUrl`)            | the server guards `/api/*`, and an `<img>` cannot set a header                                   |
| Animations must survive `prefers-reduced-motion`                         | the global override in `index.css` needs `!important` to beat Motion's inline styles             |

`apps/desktop/src/view/components/ui.tsx` holds the primitives; prefer them over raw
elements. Radix supplies `Dialog`, `Select`, `DropdownMenu` and `Tooltip` — real portals
and focus traps, so modals are no longer hand-rolled overlays.

**The UI is testable now.** `bun run server` + Playwright drives the same app the window
does. The old "no automated UI testing on Linux" limitation was a GPUIX constraint and no
longer applies.

---

## The two contracts to be careful with

### 1 · The AL wire contract

OData binds an unbound action's body onto the AL method **by parameter name**. Rename
either side and it fails at runtime with an unhelpful message; no compiler spans the
repos.

The body is built in one place — `previewRequestBody()` in `packages/core/src/bc.ts` —
so it can be asserted against the AL source. Keep it that way.

### 2 · `BcError`

The taxonomy in `packages/core/src/bc.ts` is the contract the plan says to get right once.
`kind: "render"` carries **BC's own message verbatim** — the single highest-value signal in
the system. Never summarise it away; the original previewer threw it into `console.error`
and that was the bug worth fixing.

---

## Testing

`test/` covers all five packages. Tests are offline, use fixtures checked into
`test/fixtures/` (`Default.rdl`, `preview.pdf`), and run in ~5s — they need poppler +
ImageMagick on `PATH` but no tenant. CI runs `bun run check` + `typecheck` on every topic
branch (`.github/workflows/check.yml`); `.github/workflows/build.yml` builds the
per-platform bundles on a `v*` tag or manual dispatch.

|                    |                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.test.ts`     | store, migrations, dedupe, queue, chat persistence, URL escaping, the legacy switch                                                                                                                         |
| `feedback.test.ts` | XML, lint, **measured token costs**, diff, locate, external-tool resolution                                                                                                                                 |
| `mcp.test.ts`      | tool surface, loop controls, the ladder, wire protocol, convergence signals (no-op renders, per-result budget)                                                                                              |
| `acp.test.ts`      | capabilities, sessions, permissions, agent→client calls                                                                                                                                                     |
| `server.test.ts`   | HTTP API, WebSocket, watcher arbitration, chat restore + resume, onboarding, the MCP shim, the loopback auth token, the three real permission-title shapes, thought-chunk coalescing, the one-time briefing |

Two habits that have paid off here:

- **Assert the property, not the number.** `feedback.test.ts` asserts that a trimmed
  raster costs less than a third of an untrimmed one — that survives a poppler upgrade in
  a way a hard-coded 770 would not.
- **Test the abuse case.** A rejected render must not reset the image budget, or an agent
  bypasses the cap by making a deliberately-invalid call. That test exists because the
  bug did.

`test/fixtures/fake-acp-agent.ts` is a mock agent. If you extend it, **never await a reply
inside its stdin read loop** — that deadlocks, because the loop is what would deliver the
reply.

---

## Current state

**Working and verified:** store with migrations, OS keychain, per-tenant token cache,
render engine with dedupe and a per-connection queue, the file watcher — which now drives
hot reload: it re-renders on *any* debounced change (3s), the agent's own edits included,
not just a human's save; the whole feedback ladder including `locate`, seven MCP tools
over stdio and HTTP, the ACP client, agent chats persisted to SQLite and rebuilt across a
restart, the REST/WS server, and an Electrobun/React UI with reports, detail, settings,
onboarding dialogs and the session view — driven end to end in a browser against the
replay fixture.

**Not proven:**

- **The loop has never been measured.** Everything past Phase 2 assumes an agent can
  actually converge on a layout fix. `spikes/tasks/S2-tasks.md` is the test. This is the
  plan's own go/no-go gate and it is still open — and it **cannot** be run in replay mode,
  because the fixture PDF never changes, so an edit can never show up in the render. S2
  needs a real tenant, which means asking first.
- **Multi-turn conversations, resume via `session/load`, and the permission timeout are
  still only covered by the mock.** Several separate turns have been driven live (see
  below), but never one continuous back-and-forth in a single session, and never a
  restart mid-conversation.
- **The Electrobun packaging fixes below are themselves unverified on real CI.** They were
  found and corrected against local builds, but `build.yml` has not executed on GitHub's
  runners at all — treat the first real run as the test, not this description of it.
- **Windows and macOS are unbuilt.** Only `linux-x64` has been through
  `hutch electrobun build --env=stable`.
- **The AL is undeployed.** Uncommitted in the BaseApplication repo.

**Proven with a live agent** (Claude Code 2.1.233 via `@agentclientprotocol/claude-agent-acp`,
replay mode, several separate sessions): ACP `session/new` → `mcpServers` → the shim
re-execing `process.execPath` + `Bun.main` → HTTP `/mcp/<session>` → the running render
engine, repeatably. The agent received real tool output, the budget footer
(`Session.prompt()` now prepends a one-time briefing — ladder, budget, the "state an
expectation" rule — to the first turn only), and found the wrapped `SRICHARAN` /
`Credit Memo` cells from `layout_text` alone without reaching for a page image, unprompted.
Loop counters (renders spent, no-op renders, failures) flow from `createLayoutTools`'s
`onStats` into `SessionView.loop` and show in the session header.

Three real bugs surfaced only by this live run, all now covered by regression tests:
`autoDecision()`'s auto-allow policy failed on two of three real permission-title shapes
(`mcp__layout__layout_lint` from Claude — a leading `\b` fails because the preceding `_`
is a word character — and Copilot's human-readable title with the real name in
`rawInput.command`); `agent_thought_chunk` was not coalesced, so one paragraph of
reasoning became ~60 timeline rows of one word each; and the app-bundle staging step in
`build.yml` globbed for a directory name (`*Layout Agent*`, with a space) that Hutch does
not actually produce (`LayoutAgent`, no space) — caught before any CI run, not by one.

**GitHub Copilot CLI does not work as a provider.** Observed on 1.0.83: it accepts
`mcpServers` on `session/new` and never starts them — no shim process is spawned — then
runs `layout_params` as a *shell command* and reports "command not found". It connects
and streams normally, so this is not detectable at handshake time; `providers.ts` carries
a `note` and the picker shows it.

**Packaging:** one Electrobun bundle carries a Bun runtime, the main process, and the
Vite-built UI (327 KB boot chunk after lazy-loading Session/Settings/dialogs, down from
560 KB before splitting). `--env=stable` produces a 41 MB app plus a 35 MB zstd
self-extractor, a 36 MB installer and update metadata — smaller than the ~100 MB single
binary it replaces. **The stable build is a self-extracting wrapper, not a flat
directory**: `app/bin/` holds only `launcher`; the real runtime is compressed inside
`app/Resources/<hash>.tar.zst` and only appears once `bin/launcher` installs it to
`~/.local/share/<identifier>/stable/app`. Both non-GUI entrypoints were run from that
installed location with no repo and no `node_modules`. poppler + ImageMagick are still
resolved from the system (or a sibling `tools/` folder — not `bin/`, which is
Electrobun's own). **Known gap:** vendored tools shipped beside the release download's
wrapper are not reachable once a real user installs it elsewhere; `$LAYOUT_TOOLS_DIR` is
the workaround, bundling them *inside* the Electrobun payload is the real fix and remains
undone. Hutch does not cross-compile. No icon, signing or updater configured.

**Deliberately not built:** cloud sync, multi-user server, AL/dataset editing, a visual
drag-and-drop designer, API-key management, our own PDF renderer or docx editor.

---

## Conventions

- TypeScript, strict, `noUncheckedIndexedAccess`. No `any`; `unknown` plus narrowing.
- Comments explain **why**, not what. If a line looks odd, say what goes wrong without it.
- Errors are structured data, not strings, when something downstream must branch on them.
- Prefer one query returning a joined view (`layoutDetails`) over several round trips.
- Conventional commits. `git commit` only when asked.
- The AL repo enforces a `PIN` object prefix, a `Pinetworks.BaseApp.<Feature>` namespace,
  and file names `<id>.<Name>.<type>.al` — check `AppSourceCop.json` before adding
  objects, and compile with the AL extension's Linux `alc` before claiming it builds.
