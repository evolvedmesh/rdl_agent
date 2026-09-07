# Word (.docx) Layouts

You are right that Word layouts matter — in Business Central they are now the default
for customer-facing documents (invoices, statements, confirmations), Microsoft has kept
investing in them (the BC25 Word add-in, "export report schema as Custom XML"), and a
functional consultant can open one in Word without touching Visual Studio. RDLC is
increasingly the fallback for dense list reports where precise pagination matters.

The nuance worth stating up front: **docx is easier for humans and harder for agents.**
An RDL is one text file an agent can read, diff and edit with the tools it already has.
A docx is a ZIP of XML parts, and — critically — a *BC* Word layout is not a plain
Word document. That difference is the whole story below, and it is why "just point a
docx MCP server at it" does not work.

## 1. What a BC Word layout actually is

Three things, and the last two are what generic tooling ignores:

1. **A `.docx` package** — ZIP: `word/document.xml`, styles, headers/footers, rels.
2. **A custom XML part** (`customXml/item1.xml`) holding the *report dataset schema* —
   e.g. `urn:microsoft-dynamics-nav/reports/Report61206/1` with `CompanyName`,
   a repeating `VATEntry` node, and so on. This is what BC injects data into at runtime.
3. **Content controls** (`w:sdt`) in the body, each carrying a `w:dataBinding` with an
   XPath into that schema plus a `w:storeItemID` pointing at the custom XML part.
   Repeating sections (table rows per data item) are content controls too.

So the layout is a *binding graph*, not prose. Change the text inside a content
control and you have restyled a field. Delete the content control and you have silently
removed the data — the document still opens, still looks fine in Word, and renders blank
from BC. **That failure is invisible without rendering**, which makes the feedback loop
in [agent-feedback-loop.md](./agent-feedback-loop.md) more important here than for RDL,
not less.

## 2. The finding: most docx MCP servers cannot see a BC layout

Nearly every docx MCP server is built on **python-docx**. python-docx has no API for
content controls: `document.paragraphs` iterates direct `w:p` children of the body, and
anything wrapped in a `w:sdt` is not a direct child.

I built a docx shaped like a BC Word layout — a plain heading, a databound content
control, a repeating section containing a table, a trailing paragraph, plus a proper
`customXml` part with `itemProps` and rels — and read it with python-docx 1.2.0:

```
--- document.paragraphs (what a python-docx MCP server iterates) ---
  [0] 'PLAIN_HEADING_NOT_IN_SDT'
  [1] 'TRAILING_PLAIN_PARA'

--- document.tables ---
  count: 0

--- Ground truth: every w:t in the file ---
  ['PLAIN_HEADING_NOT_IN_SDT', 'BOUND_COMPANY_NAME', 'REPEATING_ROW_TEXT',
   'CELL_INSIDE_REPEATER', 'TRAILING_PLAIN_PARA']
```

**Two of five paragraphs. Zero of one tables.** Everything bound to the dataset — which
in a real BC layout is nearly the entire document — is invisible.

The practical consequences:

- `search_and_replace` silently misses bound content and reports success.
- "Read the document" returns the static chrome and none of the fields.
- An agent told "make the total bold" will report the text does not exist, then
  "helpfully" insert a *new* unbound paragraph that renders as literal text in every
  invoice.

Round-tripping is safer than reading: with the customXml rels wired correctly,
python-docx's `save()` preserved every part, both `w:sdt` elements and the
`dataBinding`. (An earlier run appeared to drop `itemProps1.xml`; that was a missing
relationship in my test fixture, not a python-docx defect.) So python-docx-based servers
**do not corrupt** a BC layout — they just cannot see most of it.

> Rule: for BC Word layouts, treat any python-docx-based MCP server as
> **write-only-on-static-chrome**, never as the reader.

## 3. Survey of existing docx MCP servers

| Server | Basis | Notable | License | Launch | Verdict for us |
|---|---|---|---|---|---|
| [SecurityRonin/docx-mcp](https://github.com/SecurityRonin/docx-mcp) | **raw OOXML** | 200+ tools, real tracked changes, `audit_document` structural validation | MIT | `uvx docx-mcp-server` | **Best base.** Raw XML means SDTs are at least reachable |
| [safe-docx](https://usejunior.com/products/safe-docx) | **raw OOXML** | 26 typed tools, "surgical" edits, `w:ins`/`w:del` round-trip, package integrity | Apache-2.0 | `npx -y @usejunior/safe-docx` | **Strong alternative.** Smaller, permissive licence, formatting-preservation focus |
| [knorq-ai/docx-mcp-server](https://github.com/knorq-ai/docx-mcp-server) | python-docx | 40 tools, tracked changes | — | — | Blind to content controls |
| [GongRzhe/Office-Word-MCP-Server](https://github.com/GongRzhe/Office-Word-MCP-Server) | python-docx | 2.1k★, the popular one | MIT | `uvx --from office-word-mcp-server word_mcp_server` | **Archived 3 Mar 2026 — do not build on it** |
| [word-mcp-live](https://github.com/ykarapazar/word-mcp-live) | live Word automation | edits documents *while open in Word*, per-action undo | — | — | Interesting for a "Word open beside the app" workflow; ties you to desktop Word |
| [hongkongkiwi/docx-mcp](https://github.com/hongkongkiwi/docx-mcp) | Rust | — | — | — | Worth watching; no ecosystem yet |

None of them documents content-control or custom-XML-part awareness. Assume that
capability does not exist and that we supply it.

## 4. Recommended architecture: compose, don't rebuild

Do not write a docx editor. Write the ~15% that is BC-specific and delegate the rest.

```
        ┌──────────────────────────────────────────────────┐
        │  agent (via ACP — any provider)                  │
        └───────────────┬──────────────────────────────────┘
                        │  MCP
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌────────────────────┐        ┌──────────────────────────────┐
│ docx-mcp / safe-docx│       │  bc-layout-mcp  (we write)   │
│ generic OOXML edits │       │  binding-aware + render      │
│ · text, styles      │       │  · list/inspect content ctrls│
│ · tables, headers   │       │  · edit bound field styling  │
│ · tracked changes   │       │  · validate bindings vs schema│
│ · audit/validate    │       │  · render via BC → PDF       │
└────────────────────┘        └──────────────────────────────┘
```

Both attach identically through ACP `session/new` — see
[tech-stack.md](./tech-stack.md#attaching-our-tools-provider-agnostically):

```jsonc
{
  "cwd": "/home/user/reports/SalesInvoice",
  "mcpServers": [
    { "name": "docx",      "command": "uvx", "args": ["docx-mcp-server"] },
    { "name": "bc-layout", "command": "/opt/rdl-agent/bin/bc-layout-mcp",
      "args": ["--stdio", "--session", "abc123"] }
  ]
}
```

Two implementation notes:

- **Bundle the third-party server, pin the version.** Requiring `uvx`/`npx` at runtime
  means a Python or Node toolchain on an end user's machine and a network fetch on first
  run. For a shipped desktop app, vendor the server and pin it. safe-docx being
  Apache-2.0 and Node-based makes it the easier one to bundle next to a Bun app;
  docx-mcp is MIT but pulls a Python runtime.
- **Constrain the toolset.** 200+ generic docx tools will drown the agent's context and
  invite exactly the unbound-paragraph mistake described above. Expose a curated subset,
  and put the binding-aware operations in front of the generic ones.

### What `bc-layout-mcp` must expose

The tools that only exist because this is a BC layout:

```
layout_schema()                → the dataset schema from customXml (fields, repeaters)
layout_controls()             → every w:sdt: alias, tag, XPath, storeItemID, location
                                 ← the "read the document" tool that actually works
layout_bind_check()           → every binding resolves against the schema?
                                 every schema field used? orphaned controls?
layout_field_style(tag, ...)  → restyle a bound field without touching its w:sdt
layout_render(params)         → BC → PDF   (identical contract to rdl_render)
layout_diff()                 → binding graph before/after, not just text
```

`layout_bind_check()` is the one that earns its keep. It is a deterministic, zero-token
check that catches the failure mode agents actually hit: a content control removed,
duplicated, or re-pointed at an XPath that no longer exists. Run it after every edit,
before spending a BC render.

### Tracked changes are a real product feature here

The raw-OOXML servers write edits as Word revisions (`w:ins`/`w:del`) with author and
timestamp. That gives the human a native review surface — open in Word, see exactly
what the agent changed in red and green, accept or reject per change. RDL has no
equivalent. If we support docx, **default agent edits to tracked**, and let the user
accept them. It converts "the agent rewrote my invoice" from a fear into a diff.

## 5. The feedback loop is unchanged — which is the good news

Everything in [agent-feedback-loop.md](./agent-feedback-loop.md) applies as written.
BC renders both layout types to PDF, so the pipeline downstream of the render —
`pdftotext -layout` first, geometry diff second, trimmed page image last, `rdl_locate`
for anchoring — is **format-agnostic**. The measured costs (~500 tokens for text,
~726 for a trimmed 150 dpi page) carry over unchanged.

Two adjustments:

- **Anchoring gets easier.** For RDL we map a pixel back to a `<Textbox Name=...>`. For
  docx we map it back to a **content control tag**, which is a stabler and more
  human-meaningful identifier. `layout_controls()` plus the bbox data gives a cleaner
  join than the RDL side has.
- **Add a fast local loop, carefully.** Pure styling changes (fonts, spacing, borders)
  do not need BC or live data. Rendering the docx locally with LibreOffice
  (`soffice --headless --convert-to pdf`) turns a multi-second BC round trip into a
  local one. Neither `soffice` nor `pandoc` is installed on your machine, so this is an
  optional dependency to add. **Caveat: LibreOffice's rendering is not Word's and not
  BC's** — fonts, table breaks and pagination will differ. Use it for fast iteration,
  and make the BC render the authority before anything is called done.

## 6. The AL side

Their existing endpoint takes `rdlFileAsBase64`. Word layouts need a sibling — most
likely `wordLayoutAsBase64` on the same action, with the layout type inferred or passed
explicitly.

The AL primitive is `Report.SaveAs(reportId, params, ReportFormat::Pdf, outStream,
layoutRecord)`, where the layout comes from **Report Layout List (2000000234)** /
Tenant Report Layout rather than the obsolete Custom Report Layout (9650). For a custom
layout type there is also `OnCustomDocumentMergerEx` on codeunit ReportManagement.
**Verify the exact overload against your BC version** — this is the one part of the plan
I have not confirmed against a live tenant, and it decides whether a docx can be
rendered transiently or must be persisted as a tenant layout first (which would leave
debris on the customer's environment and needs cleanup).

## 7. Consequences for the product

- **The RDL/docx split is a first-class concept, not a flag.** Report → layouts (an RDL,
  one or more Word layouts, maybe Excel). The app should detect the type and load the
  matching toolset, because the tools genuinely differ even though the render loop does
  not.
- **The name will stop fitting.** `rdl_agent` and tools called `rdl_*` will read wrong
  the moment docx lands. Rename the tool surface to `layout_*` now, while it costs
  nothing, and keep `rdl_*` only for RDL-specific operations.
- **The audience widens.** RDL editing implies a BC developer. Word layout editing is
  something a functional consultant does — which sharpens open question #2 in the
  [README](./README.md), and probably answers it: docx is how this product reaches
  people who would never open Visual Studio.

## 8. Open questions

1. **Does any MCP server handle `w:sdt` properly?** I found none that documents it.
   Before writing `bc-layout-mcp`, spend an hour reading docx-mcp's and safe-docx's
   source for SDT handling — if one already traverses them, that changes the build.
2. **Repeating sections are the hard case.** Editing a row template inside a repeating
   content control, without breaking the repeat, is the operation most likely to go
   wrong. Test it first; it is the acceptance criterion for the whole docx path.
3. **Does BC accept a transient Word layout for rendering**, or must it be installed as
   a tenant layout? Determines whether preview is side-effect-free.
4. **Headers/footers carry bound controls too**, and live in separate package parts.
   Confirm the chosen server reads them.
