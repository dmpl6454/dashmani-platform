# Sales portal: what we can add (exploration notes, 19 Nov 2026)

Goal from sir: make the sales portal genuinely useful, with the Pipeline first. Campaign status
should be visible on the board without opening a project, and pitch documents must survive even
if chat is deleted.

## What exists today

**Sales portal pages:** Dashboard, Inventory, Clients, Quotes, Orders, Bookings, Pipeline, Creators
(Billing is a separate portal).

**Pipeline:**
- Board of phases. A card shows title, phase, due date, owner and an unread count. New phases are
  coming with #305: Brief → Planning → Review → Approved → Not approved → Live / Ongoing → Billing →
  Reporting → Payment. The script has not been run yet.
- Project page: chat thread (text only, no attachments), Details (title, description, dates,
  client), Members, and the Work tab:
  - Versions: video / caption / thumbnail, as a link or an uploaded file, numbered v1, v2…
  - Approval: ask a reviewer, who approves or asks for changes.
  - Pages: where it gets posted, each with its own status draft → scheduled → published, plus the
    live link.
- My Work, Shoot Desk, Workload, and Chat (channels, DMs and campaign channels).

## Gaps found

1. **No place for pitch / brief / quote / report documents.**
   - The Work tab is built for creatives (video, caption, thumbnail), not sales documents.
   - Anything shared in chat is plain text, and a deleted message's text is wiped.
2. **The board card says nothing about progress.**
   - The card data (`PipelineHeader`) has no work summary: no review state, no "pages live",
     no money.
   - You must open the project to know what is happening.
3. **The review / approval / "page is live" history is written as chat messages.**
   - The Work data itself is safe.
   - The readable history sits in the chat, mixed with conversation.
4. **The Pipeline is not connected to the rest of sales.**
   - A project links to a client, but the client page does not list its projects.
   - Quotes and orders have no link to a project.
   - The Dashboard shows nothing from the Pipeline.
5. **There is no money on a project** (deal value / budget), so there is no "pipeline value by
   phase".
6. **Every new project starts empty.** There is no checklist or template per phase.

## Ideas, ranked by value to the company

| # | Feature | What it gives | Size |
|---|---------|---------------|------|
| 1 | **Documents tab on each project.** Pitch deck, brief, quote, report, other; link or upload (R2 already set up); status Draft / Sent / Accepted / Rejected; never touched by chat deletion | Sir's main ask: the pitch is never lost | Medium (new table + API + UI) |
| 2 | **Status line on the board card**, e.g. "Pitch sent 2d ago", "Waiting for review", "3/5 pages live", "Overdue 2d" (red) | See status without opening the project | Medium (board snapshot needs a summary) |
| 3 | **"Current status" note**, one line the owner updates ("Client wants revised rates"), shown on the card | Human context at a glance | Small |
| 4 | **Activity timeline** on the project: phase moves, documents, reviews, pages live; separate from chat | History survives chat cleanup | Medium |
| 5 | **Pipeline section on the sales Dashboard**: count per phase, overdue, waiting on client or reviewer, this week's go-lives | One screen for managers | Medium |
| 6 | **Deal value on a project** → pipeline value per phase; filled from the linked quote | Sales forecasting | Medium |
| 7 | **Connect to sales**: client page lists its campaigns; "Create campaign from quote/order"; project shows its quote/order | Less double entry | Medium |
| 8 | **Phase checklist** (e.g. Brief: brief doc, budget, deadline; Billing: invoice raised) shown on the project and as "4/6" on the card | Nobody skips a step | Medium |
| 9 | **Board filters**: by client, owner, overdue, "waiting on me"; list view with sortable columns | Faster to find things | Small–Medium |

## Suggested order

1. Documents tab (#1). Its document statuses then feed the card status.
   **Built locally 20 Nov 2026** on branch `feat/sales-pipeline-documents` (not pushed). See the
   "Pipeline project documents" section in CLAUDE.md. Needs `scripts/apply-pipeline-docs-ddl.sh`
   on prod before merging.
2. Card status line + "Current status" note (#2, #3). **Built locally 23 Nov 2026** (same branch,
   same DDL script). Also built: 📎 chat attachments that land in Documents, and a full-screen
   photo viewer.
3. Dashboard Pipeline section (#5) — **built locally 23 Nov 2026**, plus "Latest from chats" — and
   board filters (#9) — built 24 Nov, then **removed the same day** (owner: it didn't look good).
4. Activity timeline (#4). **Built locally 24 Nov 2026** (sales project page, "Activity" tab).

**Not now (decided 20 Nov 2026):** deal value (#6), sales links (#7) and phase checklists (#8)
are out of scope for now. Revisit only if asked.

Each is its own PR. Anything that adds a table needs the DDL step on prod before merging (see
CLAUDE.md, Pipeline schema rules).

## To check with the team later

- Are #305's new phases final? Card status and checklists depend on them.
- Which document types do they really use, and is "Accepted / Rejected" right for pitches?
- Who updates the status note, and how often?
