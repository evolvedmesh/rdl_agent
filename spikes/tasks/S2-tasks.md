# S2 — Does the agent loop converge?

The one spike that can invalidate the product. Everything after Phase 2 assumes it
passed.

**Kill criterion (from the plan):** if a competent agent cannot do these simple tasks in
under 10 iterations each, *stop and rethink the product, not the code*.

## Setup

```bash
bun spikes/bin/s2-reset.ts              # fresh working copy of Default.rdl
claude                                   # .mcp.json attaches the layout-spike server
```

Each task is one fresh `claude` session against a fresh working copy. Do not carry
context between tasks — the point is to measure a cold start on a real request.

After each task:

```bash
bun spikes/bin/s2-report.ts | tail -40
```

and fill in the scoring table below **by eye, from the rendered PDF** — not from what
the agent claimed. The agent grading its own work is exactly the failure mode the
first/last visual comparison exists to prevent.

## The report under test

Report 61206, *Calc. and Post VAT Settlement*, A4, 1 page, 11-column VAT table. It ships
with genuine defects, which is why it is a good subject. From `pdftotext -layout`:

```
06/17/25   PSCM/25/00007   Credit    Sale     500.00   25.00  ...  3116   SRICHAR
                           Memo                                            AN
```

Two columns are too narrow: `User ID` splits *SRICHARAN* across two lines, and
`Document Type` wraps *Credit Memo*.

**The constraint that makes this interesting:** the body is `18.15cm`, the page is
`21cm`, and the left margin is `1.5cm` with no right margin — so there is only `1.35cm`
of slack. A naive "just widen it" will trip the `body-exceeds-page-width` lint, which is
precisely the signal we want to see the agent read and respond to.

## The five tasks

Give the agent the prompt verbatim. Say nothing else — no hints about which tool to use
and no pointers into the XML.

| # | Kind | Prompt |
|---|---|---|
| **T1** | Widen a column | *"The User ID column is too narrow — SRICHARAN is splitting across two lines. Widen it so it fits on one line."* |
| **T2** | Fix a wrap | *"Something in this report is wrapping that shouldn't be. Find it and fix it."* |
| **T3** | Bold the totals | *"Make the Total row bold so it stands out from the detail rows."* |
| **T4** | Move a field | *"Move the Settlement Account line so it appears above Document No. instead of below it."* |
| **T5** | Add a logo | *"Add the company logo to the top-right of the page header."* (supply a PNG) |

T2 is the diagnostic one — it states an outcome, not an instruction, so the agent has to
find the defect before fixing it. T1 and T2 also compete for the same 1.35cm of slack;
run them in separate sessions.

## Scoring sheet

Copy per task. `bun spikes/bin/s2-report.ts` fills the first four rows.

```
Task:                     T_
Iterations (renders):
BC round trips:
Feedback tokens (est):
Wall clock:

Did it converge?          yes / no / partially
Correct by eye?           yes / no          ← judge the PDF, not the agent's summary
Did it break anything?    (page count, other columns, margins)
Which channel found it?   lint / text / diff / image
Images requested:         _   (each ~750 tokens — was each one necessary?)
Wrong turns:              _   (renders whose diff contradicted the stated expectation)
```

## What to watch for

These are the observations that change the design, and they matter more than the pass or
fail:

1. **Did `layout_text` alone find the defect**, or did the agent reach for pixels first?
   The whole cost model rests on text-first.
2. **Did the agent locate the right XML element without help?** 4,139 lines, 120
   textboxes, 287 styles. If it flails here, `layout_locate` moves from "Phase 2 nice to
   have" to *the thing that makes the loop work* — the plan already suspects this.
3. **Did the stated expectation match the geometry diff?** If the agent routinely
   expects one thing and gets another, the convergence-control design is load-bearing.
4. **Did lint catch a body overflow before a BC round trip was spent?** That is the
   zero-token channel earning its place.
5. **Token split across channels.** If images dominate, the rationing is not working.

## Recording the answer

Write the outcome into `spikes/tasks/S2-results.md` — five scoring sheets and a verdict
on the gate. That file is the input to the Phase 1 go/no-go, and to the decision about
whether `layout_locate` gets built early.
