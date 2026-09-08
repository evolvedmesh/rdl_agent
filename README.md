# RDL Agent

Agentic RDL and DOCX report layout manipulation.

## Installation

Download the latest build for your platform from the [Releases](../../releases).

## Requirements

* **A Business Central tenant** running the Pinetworks Base Application with the
  `PINLayoutPreview` web service published.
* **A Microsoft Entra app registration.** One multi-tenant registration covers all your
  clients. Give it the `ReportLayout.ReadWrite.All` permission. Its client ID and secret
  go into the app's shared credentials during first run.
* **An ACP agent (optional).** Claude Code, GitHub Copilot CLI, Gemini CLI, Codex or
  opencode, if you want to hand layouts off to an agent. The app uses whichever CLI you
  already have installed and signed in, so there are no API keys to manage.

## First run

Nothing is set up on a fresh install. Work through these four steps in order.

### 1. Shared credentials

Go to **Settings → Shared credentials** and enter the client ID and secret from your Entra
app registration. Every client connection reuses these; only the tenant changes.

The secret is stored in your OS keychain. It isn't saved to the database or written to
logs, and the field won't display it back to you once it's set.

### 2. A client and a connection

Under **Settings**, add a client, then add a connection to that client's card.

A client is a customer organisation. A connection is one Business Central target for that
customer: tenant ID, environment and company.

The **company** has to match Business Central exactly, including case, spacing and
punctuation.

Press **Test connection**. It reports which part of the setup, if any, is still missing:

| Result | What to do |
| --- | --- |
| OK | Ready to go. |
| Not consented | Grant admin consent to the app registration in that tenant. |
| Not registered in BC | Add the client ID on BC's *Microsoft Entra Applications* page, set it to Enabled, and assign permission sets. |
| No permissions | The registration exists but has no API access. |
| Unreachable | A network problem, or the environment name is wrong. |

Both the consent and the BC registration have to be in place.

### 3. A report

Go to **Reports → Add report** and enter the Business Central object ID and a name, for
example `61206` and *Calc. and Post VAT Settlement*.

### 4. A layout

Open the report and choose **Add layout**. Pick the report, client and connection, then
give the path to the layout file and its preview parameters.

Use a working copy of the layout file, not an original you want to keep. The agent edits
it in place.

Preview parameters reference real records such as document numbers, G/L accounts and date
ranges, so they belong to a client rather than to a report. Don't write them by hand. Use
**Fetch from BC** on the params field to list the settings saved for that report in the
connection's company and pull the one you want. If no settings exist yet, create them in
BC through **Report Settings → New**, or through **Report Parameters for Layout Preview**
(page 60799). A layout with no parameters shows up as **no params** in the table.

## Using it

### Reports

Each report gets a card showing its ID, name, how many clients have a layout for it, and
the status of the last render for each. Once you've run a few renders, the header also
shows the accumulated BC render latency (p50 and p95).

### Report and client detail

These are the same table seen from two directions. A report lists its clients; a client
lists its reports. Click a row and its most recent render opens on the right.

Each row has four actions:

| Action | What it does |
| --- | --- |
| Render | Sends the layout to Business Central now. |
| Agent | Starts an agent session on the layout. |
| Params | Fetches or edits the preview parameters, or switches the connection. |
| Duplicate | Copies the layout to another client. |

If you edit the layout file in your own editor, the preview re-renders a few seconds after
you stop typing. Saving the same bytes twice doesn't trigger another call to BC.

### The preview

Page navigation, and zoom from 75% to 200%. Zooming re-renders at a higher DPI instead of
scaling the existing image, so the text stays crisp.

### Agent sessions

Choose **Agent** on a layout row. The app starts your installed CLI with the layout's own
directory as the working directory, so a session can't see another client's files.

The session view has the conversation, the agent's plan, its tool calls, a running total
for tokens and cost, and the rendered page alongside. Worth knowing:

* Writes need your approval. Reads and the app's own tools run without prompting; anything
  that changes a layout file stops for confirmation.
* Edits the agent makes refresh the preview just like a manual save would.
* When a session ends you can switch between the first render and the latest one to judge
  the result yourself.
* Sessions are saved. Close the app and the conversation, plan and cost are still there
  next time. Reopen a session from the sidebar and press **Resume** to continue it.

The agent starts with the cheap checks and works up: it lints the XML, reads the page as
text, diffs the geometry against the previous render, and only looks at the pixels if it
still needs to. It can also ask where something on the page came from and get back a file,
line and column.
