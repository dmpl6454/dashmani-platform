# sales.digitalsukoon.com — design (2026-10-26)

Owner ask: *"create sales.digitalsukoon.com for sales of our inventory, invoicing, billing with all platforms inventory."*

## What already exists (build on, never duplicate)
- **Inventory**: `social_accounts` (every channel, every platform) + `meta_assets` (connected Pages/IG with 28-day metrics) + `campaign_rate_cards` (our price per account × format, paise; category).
- **Orders placed by clients**: `campaign_bookings` / `campaign_booking_items` (frozen prices, `transitionBooking` state machine, review queue, delivery tracking, Razorpay — currently in *offline* mode, so a submitted booking is marked `paid_pending_review` with **no record that money was collected**).
- **Clients**: `clients` (one login per company; no GSTIN / address / legal name), staff CRUD behind `clients.*`.
- **Staff auth**: employee tokens (`POST /v1/auth/login`), `requireInternalUser`, `requirePermission`, roles seeded in `packages/db/prisma/seed.ts`.

## What this adds
| Area | Model(s) | Notes |
|---|---|---|
| Seller profile | `system_settings` key `sales.seller` (JSON) | legal name, GSTIN, address, state code, bank/UPI, prefixes, default SAC `998365`, default GST 18%, due days, terms. Invoices cannot be **issued** until it is complete. |
| Client billing profile | `client_billing_profiles` | legal name, GSTIN, PAN, address, state + GST state code, billing contact. 1:1 with `clients`. |
| Quotes | `sales_quotes`, `sales_quote_items` | staff-made; lines come from the inventory (rate-card priced) or are custom; discounts; validity; `draft → sent → accepted/declined/expired → converted`. |
| Orders | `sales_orders`, `sales_order_items` | the confirmed deal (from a quote or direct); PO number; schedule per line; optional link to a `campaign_booking` for fulfilment; `draft → confirmed → in_progress → delivered → closed / cancelled`. |
| Invoices | `sales_invoices`, `sales_invoice_items` | tax invoice or proforma; from an order, from a campaign booking, or free-form; **number assigned at issue** per financial year (`DS/26-27/0001`); seller + buyer snapshots frozen at issue; CGST/SGST (intra-state) or IGST (inter-state) or none (export/SEZ, explicit); round-off to the rupee; amount in words; `draft → issued → paid / cancelled` (partially paid and overdue are derived). |
| Payments | `sales_payments`, `sales_payment_allocations` | offline collections (bank transfer / UPI / cheque / cash / Razorpay reference), receipt numbers, TDS withheld by the client, allocation across invoices. |
| Credit notes | `sales_credit_notes` | against an issued invoice; same tax split; numbered `CN/26-27/0001`. |
| Audit | `sales_events` | append-only, every status change and money action. |
| Sequences | `sales_sequences` | one row per `kind:FY`, locked `FOR UPDATE` — numbers are never reused or skipped by concurrent issuers. |

Money: integer paise, INR. Statuses: VARCHAR. Dates that are calendar days: `DATE` with IST semantics. Nothing here ever reads Meta earnings (USD).

## GST rules implemented
- Rate in basis points per document (default 1800). Tax base = Σ line (qty × unit − line discount) − document discount.
- `taxMode`: `intra` (CGST = SGST = half the rate), `inter` (IGST), `none` (0%, for exports / SEZ under LUT — the invoice prints the reason). Default from the buyer's GST state code vs the seller's; staff may override.
- Place of supply = buyer's state code; printed on the invoice. SAC per line, default `998365` (sale of internet advertising space).
- Totals rounded to the nearest rupee with a printed round-off line (configurable).
- Numbering: financial year April–March; prefix from settings; invoices consume a number only when issued; cancelled invoices keep their number (never deleted).

## Portal (`apps/sales`, static export, nginx, Channel Surf design)
Dashboard · Inventory (every channel, every platform, live followers/views + rate-card prices, search/filter) · Clients (+ billing profile, statement) · Quotes (builder, send/accept/convert) · Orders (fulfilment status) · Invoices (issue, print/PDF, record payment, credit note) · Payments · Settings (seller profile, numbering).
Sign-in = staff portal account; access = role **Sales**, Admin or Super Admin. API gate: `[authenticate, requireInternalUser, requirePermission("sales", …)]`.

## Deploy
Static export served by nginx from `apps/sales/out` behind the Cloudflare origin cert (DNS `sales` added 2026-10-26, nginx site created). `deploy.sh` / `ci.yml` loops gain `sales`; CORS gains `SALES_APP_URL`; DDL applied by hand on prod via `scripts/apply-sales-ddl.sh` **before** merging (the runbook rule — never `db:push` on prod).

## Out of scope (follow-ups)
Razorpay payment links for invoices; emailing invoices with the PDF attached (download first); multi-user clients; e-invoicing (IRN) — only required above the GST turnover threshold; recurring/retainer billing.
