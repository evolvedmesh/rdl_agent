# CLAUDE.md

**Read [AGENTS.md](./AGENTS.md) first.** It holds the project state, the package
boundaries, the webview rules, the testing conventions and the hard rules about Business
Central and secrets. This file is only what is specific to working here with Claude Code,
and it deliberately does not repeat AGENTS.md — two copies of the same guidance drift, and
the stale one gets followed.

---

## Orientation, in order

1. **[AGENTS.md](./AGENTS.md)** — how to work on this codebase
2. **[docs/architecture.md](docs/architecture.md)** — how it works and why
3. **[docs/implementation-plan.md](docs/implementation-plan.md)** — the phases, the
   decision gates, the risk register. The four research documents beside it are the
   evidence for those decisions; read one when you need to reopen a decision, not before.

The plan is unusually load-bearing here. It names kill criteria and go/no-go gates, and
the most important one — *does the agent loop converge?* — **is still open**. Don't build
past it without saying so.

---

## CodeGraph

This repo is indexed (`.codegraph/`). Use it **before** grep, find, or opening files to
orient yourself.

```
codegraph explore "RenderEngine render dedupe"
codegraph explore "how does the MCP shim reach the app"
```

Prefer the `codegraph_explore` MCP tool when it is available — pass `projectPath` if the
server has no default project. If it is listed as deferred, load it by name via tool
search rather than falling back to grep.

What one call gives you that a grep loop does not:

- the relevant symbols' **verbatim, line-numbered source**, current on disk
- the **call paths** between them, including dynamic-dispatch hops grep cannot follow
- **which tests cover each symbol** — so you know whether a change is protected
- a **blast radius**: every caller of what you are about to edit

That blast radius is the reason to reach for it before an edit, not only when you are
lost. Treat returned source as already read — do not re-open those files.

---

## Verifying UI work

The UI is a webview, so **drive it in a real browser** — that is the fastest loop and it
is how the screens in this repo were actually checked:

```bash
LAYOUT_DATA_DIR=/tmp/scratch RDLA_FAKE_BC=$PWD/test/fixtures/preview.pdf \
  LAYOUT_PORT=7788 LAYOUT_NO_AUTH=1 bun apps/desktop/src/main.ts serve
```

Then open `http://127.0.0.1:7788/` and click through it, or drive it with Playwright.
Measuring the DOM beats guessing: a client name truncated to `A…` was diagnosed in one
call by reading `getBoundingClientRect()` across the row, which showed a stray `flex-1`
spacer splitting the space with the column it was starving.

For the real window use `grim` against the compositor (AGENTS.md has the recipe). The
point worth repeating is: **actually look at the image**. Wrapped labels, a page clipped
at its left edge, and rows folding into a jumble were all invisible in the code.

**A blank window is almost never your code.** WebKitGTK's accelerated compositing fails
under XWayland on this machine and paints nothing at all, silently. `bun run desktop`
sets `WEBKIT_DISABLE_COMPOSITING_MODE=1`; a bare `hutch electrobun dev` does not.

---

## Before you say it works

```bash
bun run test && bun run typecheck
```

Both, every time. "It compiles" is not the same as "the tests pass", and this codebase has
had bugs that only a test caught — a shim wired to a non-executable file, a rejected
render that reset the image budget, dropdowns frozen empty by a `useState` initialiser.

If you touched the AL repo, compile it too:

```bash
dotnet ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/linux/alc.dll \
  /project:"$PWD/app" /packagecachepath:"$PWD/.alpackages" /out:/tmp/out.app \
  /analyzer:<...>/Microsoft.Dynamics.Nav.CodeCop.dll \
  /ruleset:"$PWD/Pinetworks.CodeCop.ruleset.json"
```

**The AL compiler rewrites files as a side effect** — it normalises `.rdlc` line endings
and generates `app/Translations/`. Check `git status` afterwards and revert what you did
not intend to change.

---

## Things to get right here

**Ask before touching Business Central.** Every render is a live call against a customer's
tenant with a secret that unlocks all of them. Hot reload makes this easier to trip over:
an agent session pointed at a real connection re-renders on every edit it makes (debounced
3s), not just when it calls `layout_render`. Do your work in replay mode — it covers
everything else.

**Report honestly.** This project has a plan with explicit gates, and the useful answer is
usually *"built, but unproven — here is what would prove it"* rather than a checkmark. If
a claim rests on a mock, say so.

**Look for the bug you introduced.** Several fixes in this repo came from auditing work
already called done. When you finish something, spend a moment asking what would fail
first if you were wrong — then check that.

**Don't commit unless asked.** Both repos are staged, not committed.
