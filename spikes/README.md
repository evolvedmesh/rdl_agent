# Phase 0 — de-risking spikes

> **Most of this is now history.** The `src/` modules that lived here became
> `packages/core` and `packages/feedback`, and the throwaway MCP server became
> `packages/mcp`. What remains is the record of what each spike asked, and the S2 task
> set — which is still unanswered and still the gate everything after Phase 2 rests on.

Timeboxed answers to the questions that change the plan. See
[../docs/implementation-plan.md](../docs/implementation-plan.md#phase-0--de-risking-spikes).

> **Do not start Phase 1 until S1–S3 are answered.** S2 is the one that can invalidate
> the product, so it goes first.

| Spike | Question | Status |
|---|---|---|
| **S2** | Does the agent loop converge? | **still unanswered** — the task set below now runs against the real app |
| **S1** | BC render latency and throttle ceiling | **provisionally answered: ~2s.** Harness built for a measured p50/p95 |
| S3 | Does ACP deliver what it advertises? | not started |
| S4 | Which desktop shell survives this hardware? | **answered: GPUIX renders on Hyprland/Wayland/NVIDIA.** No automated UI testing on Linux. See the root README |
| S5 | Can BC render a supplied docx transiently? | not started |

## S1 — provisional answer

**~2 seconds per render**, reported from experience with `rdl_previewer` rather than
measured. That is comfortably inside the 20s kill criterion, so **the interactive-loop
premise holds** and Phase 4's UX does not need to be async/batch. A 10-iteration session
is ~20s of BC wait.

`bin/s1-latency.ts` exists to turn that into a measured p50/p95 and to find the throttle
ceiling, which is still unknown and still sets the per-connection concurrency in
[report-projects.md §6](../docs/report-projects.md#6-concurrency-and-throttling).

## Verifying the harness — no tenant needed

```bash
bun spikes/bin/selftest.ts     # 40 checks, ~15s, no network
```

Drives the whole ladder over the real MCP wire protocol with Business Central replaced
by a recorded response: handshake, all six tools, the loop controls, content-hash
dedupe, the geometry diff, and every branch of the `BcError` taxonomy. This is the
plan's *"record real BC responses once and replay them; do not hit a live tenant in CI"*
rule, built in from the start.

Replay mode is available to any entry point:

```bash
RDLA_FAKE_BC=/path/to/preview.pdf  RDLA_FAKE_LATENCY_MS=2000  bun spikes/bin/s2-mcp.ts
RDLA_FAKE_BC=error:consent         bun spikes/bin/s2-mcp.ts    # provoke a BcError kind
```

It is not a renderer — it returns the fixture whatever the layout says — so it proves
the pipeline's mechanics, never a layout's correctness.

## Running S2 — does the loop converge?

The tools now live in the app, so a session is started from the UI (a layout row's
**Agent** button) or against the CLI shim. The five tasks and the scoring sheet are
unchanged.

Then run the five tasks in [tasks/S2-tasks.md](./tasks/S2-tasks.md), one per session, and
score them:

```bash
bun spikes/bin/s2-report.ts
```

## Running S1 — how slow is BC?

**Both modes hit a live Business Central tenant**, and burst mode deliberately tries to
provoke a 429. Run against a sandbox. Without `--confirm` it prints what it would do and
exits.

```bash
bun spikes/bin/s1-latency.ts --n 20 --confirm      # p50 / p95 over 20 serial renders
bun spikes/bin/s1-latency.ts --burst 8 --confirm   # find the throttle ceiling
```

Kill criterion: **p95 > ~20s** means the interactive-loop premise dies and Phase 4's UX
becomes async/batch.

## What is here

Spike code, but not throwaway spike code — `bc.ts`, `lint.ts`, `diff.ts` and `pdf.ts`
are the first draft of `packages/core` and `packages/feedback`, and the `RenderResult` /
`BcError` contract is the one the plan says to get right once.

```
src/config.ts    reads the existing rdl_previewer config in place; composes the OData URL
src/bc.ts        TokenCache (per tenant) + PreviewRdl + the BcError taxonomy
src/xml.ts       minimal RDL-shaped XML parser with line numbers
src/lint.ts      channel 1 — deterministic rules, pre-render (XML) and post-render
src/pdf.ts       channels 2–4 — layout text, word geometry, trimmed page rasters
src/diff.ts      channel 3 — geometry deltas against the previous render
src/render.ts    RenderEngine — hash dedupe, per-connection queue, structured results
src/mcp.ts       dependency-free MCP server over stdio
bin/s1-latency.ts   S1
bin/s2-mcp.ts       S2 — the layout_* tool surface
bin/s2-report.ts    S2 — turns a session log into iterations and tokens
bin/s2-reset.ts     S2 — fresh working copy per task
src/fake-bc.ts      recorded-response replay, so none of this needs a live tenant
bin/selftest.ts     40 end-to-end checks over the MCP wire protocol, offline
```

**Secrets.** Nothing here stores a credential. `config.ts` reads
`rdl_previewer/src/confidential.json` *in place* precisely so the shared client secret —
which unlocks every client tenant — does not gain a second copy. Phase 1 replaces this
with the OS keychain. The request body is never logged: `reportParamsXml` contains
customer data.

## Measured so far (offline, on the checked-in sample)

Confirms the token costs in
[agent-feedback-loop.md](../docs/agent-feedback-loop.md#measured-costs):

| Channel | Result |
|---|---|
| `layout_text` | 2,008 chars ≈ **502 tokens** |
| Page @ 150 dpi, untrimmed | 1241×1754 ≈ **2,902 tokens** |
| Page @ 72 dpi, untrimmed | 596×842 ≈ **669 tokens** |
| **Page @ 150 dpi, trimmed** | 1092×528 ≈ **769 tokens** — 3.8× cheaper than untrimmed *and* sharper than 72 dpi |
| Geometry diff of a realistic column change | 353 chars ≈ **88 tokens** |
| XML parse + lint of the 4,139-line RDL | **5 ms**, zero tokens |

Lint verified to fire on: body wider than the page (the blank-alternate-page fault),
items overhanging the body, chrome taller than the page, and malformed XML — the last of
which short-circuits before spending a BC round trip.

## The server half

`bc.ts` calls the AL that lives in the Pinetworks Base Application repo:

```
POST .../ODataV4/PINLayoutPreview_PreviewLayout?company='{company}'
{ reportId, description, reportParamsXml, layoutFormat, layoutFileAsBase64 }
  -> { "value": "<base64 pdf>" }
```

That is codeunit 60796 `PIN Layout Preview API`, published as the web service
`PINLayoutPreview`, in `al_dev/BaseApplication/app/src/ReportLayoutPreview/`. It inserts
the supplied layout as a transient `Tenant Report Layout`, renders it, and deletes it —
so a preview leaves nothing behind and does not disturb any layout a user has selected.

`layoutFormat` is derived from the file extension (`layoutFormatFor`), so a `.docx`
layout already routes correctly — the client half of Phase 6 is in place.

**The keys are the contract.** OData binds an unbound action's body onto the AL method by
parameter name, so a rename on either side fails at runtime with an unhelpful message.
`selftest.ts` reads the AL source and asserts the two agree, and checks that `ws.xml`
still publishes the service the client calls.

## Not yet exercised against a live tenant

The call shape is verified against the AL signature, and the composed OData URL is
correct including the apostrophe-doubling and URI encoding an expanded URL got away with.
What only a live response can confirm: whether BC's failure bodies classify into the
`BcError` taxonomy as expected, and the real latency and throttle numbers.
