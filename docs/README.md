# Documentation

`architecture.md` and `implementation-plan.md` describe the app as built. The four
research documents below are the evidence base those decisions came from — read one when
you need to reopen a decision, not before.

For running and using the app, see the [root README](../README.md); for changing the
code, [AGENTS.md](../AGENTS.md).

| Document | What it answers |
|---|---|
| **[architecture.md](./architecture.md)** | **How the app is built** — packages, the feedback ladder, render arbitration, the error taxonomy, the AL side, and what GPUIX actually does on this hardware. |
| **[implementation-plan.md](./implementation-plan.md)** | **The build plan** — de-risking spikes, six phases, decision gates and a risk register. |
| [tech-stack.md](./tech-stack.md) | How to talk to Claude / Codex / Copilot / opencode with *one* integration, which desktop shell to build on, and what in `rdl_previewer` survives the port. |
| [agent-feedback-loop.md](./agent-feedback-loop.md) | How the agent actually *sees* its changes: the PDF→feedback pipeline, measured token costs, and the MCP tool surface. |
| [report-projects.md](./report-projects.md) | The domain model — reports, clients, layouts, connections — and how to refactor `rdl_previewer` from one-of-everything to many. |
| [docx-layouts.md](./docx-layouts.md) | Word layouts: why BC content controls break generic docx tooling, which existing docx MCP servers to compose, and what we must build ourselves. |

## The three findings that shape everything else

**1. ACP (Agent Client Protocol) is the multi-provider answer.** Every provider you
named already speaks it. It carries streaming output, permission prompts, session
resume, **MCP server attachment**, and **image content blocks** — so both the
"connect any model" requirement and the "feed screenshots back" requirement are
solved by the same protocol. We write one client, not four adapters.

**2. Pixels are the last resort, not the first.** A rendered page costs ~2,900 tokens.
The same page as `pdftotext -layout` costs ~500 and already exposes real layout
defects. Trimming whitespace before rasterizing cuts the image to ~726 tokens — 4×
cheaper *and* sharper than naively lowering DPI. The loop should be text-first,
geometry-diff second, pixels on demand.

**3. Word layouts need different *editing* tools but the same *feedback* loop.** BC
renders RDL and docx to PDF alike, so the whole pipeline above is format-agnostic. What
changes is the edit surface: a BC Word layout is a binding graph of content controls,
and the popular docx MCP servers — built on python-docx — cannot see inside them.
Measured: **2 of 5 paragraphs and 0 of 1 tables visible** on a BC-shaped layout.

## Verified on this machine

```
bun 1.3.11 (bun:sqlite + recursive fs.watch verified) · node v26.7.0
claude 2.1.233 · copilot 1.0.80 (--acp confirmed) · codex/opencode not installed
pdftoppm, pdftocairo, gs, ImageMagick present
Hyprland/Wayland · NVIDIA RTX 4070 (Vulkan OK) · webkit2gtk-4.1 present
```

`rdl_previewer/preview.pdf` was rasterized and read end-to-end as an image to confirm
the core premise works. It does — see [agent-feedback-loop.md](./agent-feedback-loop.md#the-experiment).

## Open questions for you

1. **`RdlpApi_PreviewRdl` is a custom AL extension.** It is the linchpin of the product
   and no other BC tenant has it. Is shipping that extension part of the plan?
2. **Who is the user?** A BC developer with a sandbox (has AL, VS Code, credentials) or
   a functional consultant who only wants "make the total bold"? It changes onboarding
   entirely.
3. **What is the BC round-trip latency?** It is the rate limiter of the whole loop and
   we have not measured it yet.
4. **Is docx in scope for v1, or after RDL?** It widens the audience considerably
   (question 2 above largely answers itself if so), but it adds a second edit surface
   and a dependency on third-party MCP servers.
5. **The `rdl_*` naming will not survive docx.** Worth renaming the tool surface to
   `layout_*` before anything is built.
6. **Do two clients ever share one layout file?** If you maintain a master template
   deployed to many clients, the data model needs shared layouts with per-client
   overrides — much harder to retrofit than to design in. See
   [report-projects.md](./report-projects.md#10-open-questions).
