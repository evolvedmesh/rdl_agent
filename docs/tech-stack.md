# Tech Stack Findings

## 1. Provider integration: use ACP, don't write four CLI adapters

### The naive path and why it rots

The obvious approach is to shell out to each CLI in its headless mode:

| Provider | Headless invocation | Event format |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --input-format stream-json` | Anthropic-specific NDJSON |
| Copilot CLI | `copilot -p --allow-all-tools` | its own |
| Codex | `codex exec` | its own |
| opencode | `opencode run` | its own |

Four schemas, four permission models, four session-resume semantics, four sets of
flags that change between releases. Every provider upgrade is a potential breakage in
our app. This is the single biggest long-term maintenance liability in the project.

### The finding

**All four already speak the Agent Client Protocol.** Confirmed locally:

```
$ copilot --help | grep acp
  --acp    Start as Agent Client Protocol server
```

ACP is JSON-RPC 2.0 over stdio (NDJSON) — the protocol Zed created so editors could
talk to any agent. JetBrains, Neovim and Emacs ship ACP clients today. Launchers:

| Agent | How it starts as an ACP server |
|---|---|
| Copilot CLI | `copilot --acp` (native, public preview since Jan 2026) |
| Claude Code | `bunx --bun @agentclientprotocol/claude-agent-acp` (Zed's SDK adapter, run on Bun — the adapter's `#!/usr/bin/env node` shebang would otherwise need a working system node) |
| Codex CLI | `bunx --bun @zed-industries/codex-acp` |
| Gemini CLI | `gemini --acp` (native) |
| opencode | native (`sst/opencode`) |

40+ agents in total, including Cursor, Cline, Amp, Goose, Kiro, Qwen, OpenHands.

### What we get for free

The protocol is almost suspiciously well-matched to this app:

- **`session/update` notifications** — `agent_message_chunk`, `tool_call`,
  `tool_call_update`, `plan`, `usage_update`. This *is* the UI. Streaming text, a live
  tool-call list, the agent's plan, and a running token/cost counter, all standardized.
- **`session/request_permission`** — the agent asks before touching the RDL; we render
  a native modal. We do not invent a permission model.
- **`session/load`** — conversation resume, if the agent advertises `loadSession`.
- **`session/new` takes `mcpServers`** — *our preview server attaches identically to
  every provider.* This is the crux; see §1.3.
- **`promptCapabilities.image`** — negotiated at `initialize`. Providers that accept
  images get the visual feedback loop; providers that don't get text-only, and we can
  tell which is which at connect time instead of guessing.

### The capability handshake we care about

```jsonc
// initialize response from the agent
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true }
  },
  "authMethods": []
}
```

Three flags decide how the app behaves per provider:

- `promptCapabilities.image` → can we hand it a page render at all?
- `mcpCapabilities.http` → can our MCP server run in-process over localhost HTTP
  (shared state with the UI), or must we ship a stdio shim? **stdio is mandatory for
  all agents**, HTTP is optional — so the stdio path is the one that must always work.
- `authMethods` → what "Connect your account" means for this provider.

### Attaching our tools, provider-agnostically

```jsonc
// session/new
{
  "cwd": "/home/user/reports/VATSettlement",
  "mcpServers": [
    { "name": "rdl-preview",
      "command": "/opt/rdl-agent/bin/rdl-mcp",
      "args": ["--stdio", "--session", "abc123"],
      "env": [{ "name": "RDL_APP_PORT", "value": "51733" }] }
  ]
}
```

One config, every provider. The agent never knows which model it is.

### Auth: we should not build API-key management

ACP agents reuse the user's **existing CLI login** — a Claude subscription, a Copilot
seat, a ChatGPT plan. That turns the hardest part of the product ("connect your
provider", key storage, rotation, billing confusion) into a filesystem check:

> *"We found Claude Code and GitHub Copilot on your machine. Pick one."*

If a user has no CLI, we point them at `npm i -g` and their vendor's login command.
Storing raw API keys should be an explicit fallback, not the default, and if we ever
do, it belongs in the OS keychain — not in a JSON file (see §3).

### Escape hatch

Keep one thin `RawCliProvider` behind the same internal interface for any provider
that lacks ACP. Expect to never need it, but do not let the abstraction assume ACP.

---

## 2. Desktop shell: GPUIX vs Electrobun

The deciding question is not "which is more native." It is **who renders the PDF.**

### GPUIX (`remorses/gpuix`, ~1.6k stars, Apache-2.0)

React → GPUI (Zed's renderer) → Metal/DirectX/Vulkan, via a Rust retained tree and
napi-rs. `bun build --compile app.tsx` yields a single binary with no runtime needed on
the target. macOS, Windows and Linux all ship prebuilt binaries
(`…-x86_64-unknown-linux-gnu.tar.gz`).

Its element set is not merely adequate for this app — it reads like it was designed for
one. `markdown` (agent messages), `diff` (RDL XML changes), `code` (RDL snippets),
`virtual-list` (chat and page thumbnails), `input`/`textarea` with IME and undo, native
scroll physics, `motion.div`, cross-element text selection, and `useTextSearch` with a
worked find-bar example. In a webview each of those is an npm dependency to install,
style and keep current.

**There is no webview.** For the PDF pane that means:

- ✅ `<img>` takes filesystem paths, `data:` URLs and http(s) URLs (PNG/JPEG/WebP/SVG/
  BMP/TIFF/…), with CSS-matching `objectFit` and `borderRadius`. We already rasterize
  with `pdftoppm`, so a page view is an image list.
- ✅ **Zoom is arguably better than a webview's.** A webview scales an existing bitmap;
  we re-rasterize at the target DPI and set `width`/`height`, so zooming *increases*
  real resolution. Note the README's rule: always set both `width` and `height`, or the
  box is empty until decode and then jumps to bitmap size.
- ✅ Pan uses the documented "own the offset" pattern (one `onScroll` on a non-scrolling
  parent, absolutely positioned content, `memo` the moving subtree). Programmatic
  scroll exists: `renderer.scrollTo`, `scrollToItem`, `getScrollOffset` → "jump to page
  7" is one call. Pannable surfaces must cull in JS, but culling a dozen page images is
  trivial next to the timeline example's 3,259 clips.
- ❌ **In-document text selection and search must be hand-built.** An `<img>` is a
  bitmap. Rebuilding pdf.js's text layer is possible — we already have every word's
  coordinates from `pdftotext -bbox-layout`, and GPUIX has `anchored` overlays, text
  selection and `useTextSearch` — but it is real work, and it is the one thing a
  webview would have given us free.

**Genuine gaps**, from the README's own status list:

- ❌ **Multiple windows.** Single window only. No detaching the preview to a second
  monitor — plausibly something a report designer wants.
- ❌ **Canvas element** (planned). Matters only if we want to draw annotation overlays
  on the page; absolutely positioned `div`s cover most of that need.
- ❌ App-declared menus; ❌ React Refresh under `bun --hot` (it remounts and loses hook
  state, blocked on [oven-sh/bun#40179](https://github.com/oven-sh/bun/issues/40179)).
- ⚠️ Motion springs/keyframes/variants/exit transitions "not available yet".
- ⚠️ Footguns: *"give every `<text>` a `color`"* (GPUI does not inherit color —
  uncolored text paints black and vanishes); `div` defaults to block, so
  `display: "flex"` is explicit; no shorthand `padding`/`margin`/`border`.
- ⚠️ **Nested scrolling is unsupported** — an inner `overflow: "scroll"`,
  `<virtual-list>` or `<diff>` inside a scrolling parent steals the wheel gesture.
  *This does not affect a two-pane layout*: sibling scrollers are fine, and horizontal
  `overflowX` is explicitly exempt. It does mean a scrollable diff inside a scrolling
  chat log needs an expand/collapse instead of its own viewport.

**Linux specifics** (you develop on Linux, so these matter):

- Production rendering on Linux is supported via Vulkan. What is missing is the
  **headless test renderer** — the README's table reads `Linux | Not yet | Waiting for
  GPUI's wgpu headless renderer`. That blocks automated UI regression tests locally,
  not the app itself. Metal (macOS) and DirectX (Windows) both have it.
- On **Windows and Linux, GPUI runs its blocking native event loop on a dedicated Rust
  UI thread**, so Bun's event loop stays free. Our HTTP server, WebSocket, MCP server
  and ACP subprocess I/O can live in the same process without fighting the UI. (On
  macOS it is instead a cooperative `tick()` on the JS thread — which is where the
  *never drive `tick()` from `setImmediate`* footgun lives: 73% idle CPU vs 1% when
  paced.)
- `focus` is ignored on Linux; minor.
- The polish is macOS-first — the menu bar, traffic-light positioning and the run-loop
  extension are all macOS features, and CI covers macOS and Windows.

**Unusually well-aligned extra:** GPUIX ships an automation harness explicitly for
agents driving the app — `launch({ env: { GPUIX_BACKGROUND: '1' } })`, `getByTestId`,
`click`, `fill`, `screenshot` reading the GPU surface, all working on an unfocused or
even non-visible window. For a product that is itself agentic, being able to have an
agent operate and screenshot our own UI is a real asset. (Caveat: `createTestRoot()`,
the no-window path, is the part that needs the headless renderer Linux lacks.)

### Electrobun (`blackboardsh/electrobun`, ~12.8k stars)

TypeScript framework; Hutch build CLI; platform layers in Zig/ObjC/C++. System webview
by default, optional CEF (`bundleCEF`) and WGPU (`bundleWGPU`) with
`<electrobun-webview>` / `<electrobun-wgpu>` compositing elements. Self-extracting
zstd bundles and a Zig BSDIFF updater producing kilobyte-scale updates. Typed RPC with
main/webview process isolation.

- ✅ A webview means **pdf.js or the native PDF viewer works on day one** — zoom, text
  selection, search, thumbnails, all free.
- ⚠️ **The default runtime is Cottontail (JSC), not Bun.** Bun is selectable via
  `hutch.config.ts`, but "a native desktop app written with Bun" is only partly true
  here. Worth knowing before you commit to the framing.
- ⚠️ Platform tiers: official = macOS 14+, Windows 11+, **Ubuntu 24.04+**. Other Linux
  (GTK3 + WebKit2GTK) is **community**. You develop on CachyOS/Arch — that is the
  community tier.
- ⚠️ Governance risk, stated plainly by the maintainer:
  > *"Issues and PRs can be used to share ideas, but there should be no expectation
  > that I will review, respond to, or merge them."*

  Fine for a tool you adopt as-is; a real risk if you hit a platform bug.

### A machine-specific warning

Your box is **Hyprland/Wayland + NVIDIA RTX 4070**. WebKitGTK on Wayland+NVIDIA has a
long history of blank/black webviews via the DMA-BUF renderer; the usual workaround is
`WEBKIT_DISABLE_DMABUF_RENDERER=1`. Budget a day to prove the webview path renders on
your own machine before committing. Conversely GPUI-on-Vulkan/NVIDIA/Wayland is Zed's
daily-driver configuration, so GPUIX is likely the *smoother local* experience — the
opposite of the recommendation below. Verify both with a spike.

### Recommendation: make the shell a late-bound decision

Both are viable. They fail in opposite directions, and neither risk is worth taking
before the loop works.

|  | GPUIX | Electrobun |
|---|---|---|
| PDF viewer | hand-built from page images; zoom is sharper, text-layer is work | free via pdf.js / system viewer |
| Agent chat UI | native `markdown`/`diff`/`code`/`virtual-list` | four npm deps to wire and style |
| Your machine | Vulkan — Zed's daily path on NVIDIA/Wayland | WebKitGTK on Wayland+NVIDIA is the risky combo |
| Bun | genuinely Bun | Cottontail (JSC) by default |
| Multi-window | ✗ | ✓ |
| Maturity | alpha, 1.6k★ | beta, 12.8k★, maintainer takes no PRs |
| Linux tier | supported; no headless test renderer | community (official is Ubuntu 24.04+) |

`rdl_previewer` is already a Bun HTTP server serving a browser page over WebSocket.
**Keep that boundary** and you do not have to choose yet:

```
┌──────────────────────────────────────────────┐
│  Bun core process  (all real logic)          │
│  ACP client · BC render engine · MCP server  │
│  file watch · session state · HTTP + WS      │
└───────────────────┬──────────────────────────┘
                    │  localhost HTTP + WebSocket
        ┌───────────┴───────────┬──────────────┐
     browser              Electrobun         GPUIX
   (dev loop, free)      (webview shell)   (native shell)
```

- **Day 1–N** develop in a browser. Zero shell risk, instant reload, and the render
  engine, ACP client and MCP server — the actual product — are shell-agnostic anyway.
- **Then spike both shells for a day each**, on your own hardware, against the same
  core. The two questions that decide it are empirical, not architectural: *does
  WebKitGTK render at all under Hyprland+NVIDIA*, and *is a page-image viewer with
  zoom and pan good enough without a text layer?*
- **Bias:** if the app turns out to be agent-chat-first with the PDF as a
  correctness check, GPUIX wins on both the element set and your GPU stack. If users
  spend their time reading and searching the document, the webview's text layer is
  worth more than everything else on the list.

The failure mode to avoid is committing to either shell before the feedback loop
exists — at which point the shell is a week's work either way, and you will know which
question actually mattered.

---

## 3. What survives from `rdl_previewer`

224 lines in `main.ts`, 105 in `auth_builder.ts`, 99 in `utils.ts`. The *shape* is
right — watch, POST to BC, get base64 PDF, write, reload. Port these ideas, not these
files. Concrete issues found while reading, all of which bite harder in an agent loop
than in a hand-driven previewer:

**Token refresh is broken** (`auth_builder.ts:68-95`). On expiry it calls
`this.getAccessToken(tokenUrl, false)` but discards the return value, and never clears
`this.accessToken` — so the `if (!this.accessToken)` guard below skips the refetch and
the stale token is returned. A hand-run previewer restarts often enough to hide this;
an agent session running past the ~1h token lifetime will start 401-ing mid-loop.

**Error detection misses HTTP 400** (`main.ts:169`). `if (bcCall.status > 400)` should
be `>= 400`; a plain 400 falls through to the success path.

**Errors go to `console.error` and nowhere else.** For the agent this is the single
most valuable signal — an RDL that fails to render must come back as a *structured
tool error carrying BC's message*, not a log line.

**The watcher is global and hardcoded** (`main.ts:207`, and the `filename === "Default.rdl"` check at `main.ts:150`).
It watches `./` for everything. Needs to be per-file and per-session. More importantly:
once an agent is writing the RDL, the watcher and the agent's own render request will
both fire, and the watcher can catch a **half-written file**. Write-then-render must be
arbitrated (content-hash dedupe + debounce; agent renders are explicit tool calls).

**Base64→PDF decodes char-by-char** (`utils.ts:50-58`): `atob` plus a manual loop.
`Buffer.from(b64, "base64")` is dramatically faster and matters once reports are
multi-megabyte.

**Single global state**: one `preview.pdf`, one `serverWs`. No concurrent reports, no
concurrent sessions, and a second window would fight the first.

**Secrets live in `src/confidential.json`** next to the code. Fine for a personal tool,
unshippable for a distributed app → OS keychain.

**Keep as-is:** the AADOAuth client-credentials flow, the BC OData call shape, the
base64 round-trip, and the WebSocket reload pattern. They work.

---

## 4. The dependency nobody else has

```
https://api.businesscentral.dynamics.com/v2.0/{tenant}/Dev3/ODataV4/RdlpApi_PreviewRdl
```

`RdlpApi_PreviewRdl` is a **custom AL extension you wrote**. It takes
`{ reportId, reportParamsXml, rdlFileAsBase64 }` and returns a rendered PDF. Nothing
in this product works without it, and no other BC tenant has it installed.

That makes it a product question, not a technical one:

- Shipping the app means shipping the AL extension (AppSource? a `.app` in the
  installer? per-customer deployment?).
- Onboarding must collect: tenant ID, environment, company, client ID/secret, and the
  extension's install state — then verify all of it with a test render.
- **`reportParamsXml` is per-report and non-obvious.** The sample is a 900-character
  blob of `<Options>` and `<DataItems>` for report 61206. Users cannot hand-author this.
  Now covered from both ends: `PINLayoutPreview_ListReportSettings` /
  `_GetReportParameters` read the settings a user saved (that is the **Fetch from BC**
  button on the params field), and page 60799 in the Base Application opens the report's
  own request page for the reports nobody has saved settings for.
- Every render is a **network round trip to a live BC tenant**. It is the loop's rate
  limiter and a load source on someone's production-adjacent environment. Measure it,
  cache aggressively on unchanged bytes, and consider a per-session render budget.
