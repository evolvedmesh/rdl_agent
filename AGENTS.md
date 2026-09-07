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

| | |
|---|---|
| **This repo** | the app — core engine, feedback pipeline, MCP tools, ACP client, server, GPUIX desktop UI |
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
bun run test        # 106 tests, offline, ~5s
bun run typecheck   # tsc --noEmit across the workspace
bun run desktop     # the GPUIX app
bun run server      # core only, no UI — a browser can drive it
bun run build       # one self-contained binary for this host → dist/
bun run build:all   # linux-x64 + macos-arm64 + windows-x64 (GPUIX's three targets)
```

The build is a single file that is every entrypoint — GUI by default, `<bin> serve`
headless, `<bin> mcp-shim …` the per-session proxy (the agent re-execs the binary, so
sessions work packaged). `main.tsx` routes argv before it boots GPUI. It still needs
poppler + ImageMagick on the system (`resolveTool` in `packages/feedback/src/bin.ts` looks
on PATH, in a `bin/` beside the binary, then `$LAYOUT_TOOLS_DIR`). `build:all` only makes a
*loadable* binary for a target on a host with that platform's `@gpuix/native-*` — it is a
CI-matrix helper, not a one-box cross-compile.

Run both `test` and `typecheck` before claiming anything works. The test suite needs no
tenant and no secret.

### Seeing the UI

There is **no working screenshot API on Linux** (see below), so capture the compositor:

```bash
LAYOUT_DATA_DIR=/tmp/scratch RDLA_FAKE_BC=/path/to/any.pdf bun run desktop &
sleep 12
hyprctl clients -j | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    if c.get('title')=='Layout Agent': print(c['at'][0],c['at'][1],c['size'][0],c['size'][1])"
grim -g "<x>,<y> <w>x<h>" shot.png
```

**Look at the screenshot.** Several real bugs in this UI — wrapped labels, a clipped page,
stretched badges — were invisible in code and obvious in a picture.

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
GPUIX from anything but `apps/desktop`.

---

## GPUIX rules

The desktop UI is React → GPUI → Vulkan. It is *not* the DOM, and these are not style
preferences — each one is a bug that already happened:

| Rule | What goes wrong |
|---|---|
| Every `<text>` needs an explicit `color` | GPUI does not inherit; uncoloured text paints black and vanishes |
| A `<text>` takes **exactly one** string child | `{n} items` renders as two stacked lines — use one template literal |
| `<img src>` is a **filesystem path**, not a URL | HTTP URLs fail as a file-not-found; ask the server for `/api/page-path/...` |
| Set both `width` and `height` on an image | the box is empty until decode, then jumps |
| `div` defaults to block | any row or column needs `display: "flex"` |
| No shorthand `padding` / `margin` / `border` | use the long forms; `borderWidth` + `borderColor` |
| Never nest scrollers | the inner one swallows the wheel; panes are siblings |
| Don't centre a child wider than its scroller | the leading edge clips and cannot be scrolled to |
| Badges need `alignSelf: "flex-start"` | a flex child stretches to fill the cross axis |

`apps/desktop/src/components/ui.tsx` encodes most of these. Prefer `Row`/`Col`/`Text`/
`Button`/`Badge` over raw elements.

GPUIX ships `Select`, `Combobox`, `Tooltip`, `markdown`, `code`, `diff` and `virtual-list`
— use them rather than hand-rolling. It is single-window with no portal, so modals are an
absolutely-positioned overlay at the app root.

**No automated UI testing on Linux.** The automation transport connects, but
`captureScreenshot`, `getAllText` and `getPaintedText` are undefined. `enableAutomation()`
also suppresses the visible window.

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

| | |
|---|---|
| `core.test.ts` | store, migrations, dedupe, queue, chat persistence, URL escaping, the legacy switch |
| `feedback.test.ts` | XML, lint, **measured token costs**, diff, locate, external-tool resolution |
| `mcp.test.ts` | tool surface, loop controls, the ladder, wire protocol |
| `acp.test.ts` | capabilities, sessions, permissions, agent→client calls |
| `server.test.ts` | HTTP API, WebSocket, watcher arbitration, chat restore + resume, onboarding, the MCP shim |

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
restart, the REST/WS server, and a GPUIX UI with reports, detail, settings, onboarding
dialogs and the session view.

**Not proven:**

- **The loop has never been measured.** Everything past Phase 2 assumes an agent can
  actually converge on a layout fix. `spikes/tasks/S2-tasks.md` is the test. This is the
  plan's own go/no-go gate and it is still open.
- **No live ACP session.** The client — and session resume via ACP `session/load` — is
  tested against a mock only.
- **The AL is undeployed.** Uncommitted in the BaseApplication repo.

**Packaging:** `bun run build` compiles one self-contained binary for the host — GUI,
headless `serve`, and the `mcp-shim` sub-entrypoint all in the one file. Verified end to
end: the GPUI window opens with no `node_modules`, and a live agent session drives
`layout_render` / `layout_text` through the binary re-execing itself as the shim. poppler
+ ImageMagick are still resolved from the system. Cross-target scripts compile but only
load GPUIX on a matching host. No installer, icon, signing, updater.

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
