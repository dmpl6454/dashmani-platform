# Creator direct payouts: final plan

**Final, 2026-10-12.** This version folds in the money-safety, compliance and feasibility reviews. No code, database or production system was touched. Paths are relative to `/home/user/dashmani-platform`. External facts carry a source key [R#]; the URLs are listed at the end. "UNVERIFIED" marks claims I could not confirm.

I re-read the code paths the reviews rely on, and they are accurate. In `payment.service.ts`:
- `onCaptured` reads the payment first and claims it only afterwards.
- A capture that fails half-way leaves the booking stuck.
- `refundPaymentRow` rolls the refund back on any error.
- The failure message tells staff to "refund from the Razorpay dashboard".
- `refundBookingInFull` refunds everything that is left.

Elsewhere:
- `markFailed` refunds nothing (`review.service.ts`).
- Page take-over rewrites `creatorId` on the same row (`creator-discovery.service.ts`).
- The purge is unaware of offers (`creator.cron.ts`).
- `requireActiveCreator` blocks only suspended creators.
- `auditLog` stores `req.body`.

I also re-checked several Razorpay facts against the docs: refund idempotency, dispute debits, transfer statuses, how settlement details are fetched, penny-testing behaviour, and when dashboard access becomes available.

---

## 1. How the money moves

1. **The brand pays us.** A brand books one or more creator pages and pays Digital Sukoon through Razorpay at checkout. A booking that includes a creator page can never use today's offline path.
2. **We set the creator's share aside.** When Razorpay confirms the capture, we record one payout per creator item in the same database transaction. Within minutes, we move each creator's share out of that payment into a Razorpay linked account in the creator's name, **on hold** [R11]. The share is the item price times the staff-set share, minus any TDS.
   - The money has left our balance but is not in the creator's bank, so we can still take it back [R16].
3. **The creator accepts and posts.** Staff approve the booking. The creator gets an offer showing the exact amount, accepts it, posts by hand within the posting window, and pastes the link.
4. **We check the post and release.** We use the creator's own connected account to check the post is on their page, staff verify it, and we release the hold [R13].
5. **Razorpay pays the creator's bank.** This takes "the next working day" after a hold is released [R13] or "2 working days" [R7]. Which applies is UNVERIFIED; we will measure it in the rehearsal.
6. **If the post doesn't happen, we unwind it.** This covers the creator declining, the offer expiring, the post never going up, or the booking being rejected. We **reverse the held transfer first**, and only then refund that item to the brand.

**What the creator sees.** One five-step bar per booking: Brief → Campaign → Delivered link → Payment progress → Paid. Each step is driven only by what Razorpay and our records confirm:
- "Set aside" appears only after Razorpay reports the held transfer as `processed` [R10].
- "Paid" appears only after Razorpay reports the settlement as `processed`, with its bank UTR [R21].

**What we must not say.** The money does not come "directly from the brand". The brand pays Digital Sukoon, the merchant of record, and Razorpay moves the creator's share out of that payment [R2].

**Who can be paid.** Only creators with a PAN and an Indian bank account (INR only) [R2], [R5], [R6].

---

## 2. Owner prerequisites (outside the code; start now)

| # | What | Why / what it blocks | Source |
|---|---|---|---|
| 1 | A Razorpay merchant account for Dashmani Media Pvt Ltd, with KYC complete, live and test keys, and a webhook secret. Whether one already exists is UNVERIFIED. | Route can only split payments captured through Razorpay. Test keys are needed for Phase 2. | [R11] |
| 2 | **Route activation** under the RBI rules. We need either domestic turnover above ₹40 lakh (GST-3B, FY25 or FY26) or export turnover above ₹5 lakh (bank FIRC); a self-declaration is accepted if we are GST-exempt or in our first year. We also need a **written payer-payee transparency confirmation**: the linked account "must directly interface with your customers". Review takes 5–7 business days. | **Go/no-go gate.** Phase 3 does not start until this is approved, because the plan has nothing to run on without it. | [R1], [R2] |
| 3 | Ask Razorpay to enable three things: creating linked accounts by API (otherwise "Marketplace feature is not enabled for merchants using private auth"); `route_code_support` (needed to send `reference_id`); and penny testing for new linked accounts. Also ask whether the "Direct Transfer feature" listed as a prerequisite is needed for transfers made from a payment. | Phase 2 and Phase 4 | [R5], [R9], [R2] |
| 4 | Account policy, checked for every creator account: **"Allow Refunds" OFF**, so a linked account can never refund a brand from the creator's balance. **"Dashboard Access" OFF** at launch, so creators don't see held money before they are offered the booking. | Phase 2 runbook | [R7] |
| 5 | Written answers from Razorpay before Phase 4 merges. The list is under this table. | Phase 4 | — |
| 6 | **Accountant:** <br>• the TDS section and rate (194-O vs 194C/194J; new section codes from 1 April 2026); <br>• whether TDS is due when we credit the linked account at capture or when we release; <br>• GST §52 TCS; <br>• GST on our cut; <br>• who invoices whom; <br>• whether we must keep the creator's PAN. <br>Razorpay mentions 194-O only for merchants outside India. | No live transfers until signed off. | [R23], [R24]; secondary, UNVERIFIED: [R35] |
| 7 | **Legal copy:** <br>• creator terms §1, §5, §7, §8 and §11; <br>• client terms (creator bookings are paid up front, the creator is named as the provider, refund policy); <br>• privacy policy (Razorpay receives PAN, bank details and address; link to its policy). <br>Razorpay's terms clause 2.22 requires a contract with every seller we collect for; the creator terms, accepted at bank connect, are that contract. | Go-live | [R23] |
| 8 | The decisions in section 4. | Phases 3–4 | — |

**Questions for Razorpay (all UNVERIFIED until answered):**
- **a. Payer-payee transparency.** Does our flow qualify? The brand books through our staff, and the creator accepts and posts. The transfer is made before the creator accepts that particular booking, although after they accepted our terms. [R1]
- **b. Cooling period.** Is there a 24-hour cooling period [R9], or is the account "activated immediately" [R7]?
- **c. Settlement timing.** After a release, is it the next working day [R13], 2 working days [R7], or our own schedule [R17]? **Is any fee deducted from the creator's settlement?** The settlement entity has a `fee` field [R21].
- **d. Reversals and re-holding.** Does reversing a held, unsettled transfer always succeed? Does `PATCH on_hold:true` re-hold a released transfer that hasn't settled yet [R13]? Reversal is allowed while settlement is `pending` [R17].
- **e. Late transfers and hold length.** Can a transfer be created from a payment days after capture? Is there a maximum hold length?
- **f. Minimum transfer.** The error text says 100 paise, but the fix line on the same page says "₹100" [R11]. Until answered we treat ₹100 as the floor.
- **g. Webhook payloads.** What do `transfer.processed` and `transfer.failed` look like? Whose `account_id` does `settlement.processed` carry [R22]?
- **h. Changing bank details.** Can it be done by `PATCH` [R29], or only by a support request [R2] (FAQ Penny Testing Q7)?
- **i. Category.** Which category and subcategory fit creators? Candidates: media_and_entertainment, or services → ad_and_marketing [R5].
- **j. Fees.** Are reversed transfers charged? Is the 0.25% transfer fee negotiable [R19]?
- **k. Manual fallback.** Can our staff read a linked account's full bank details in the dashboard?
- **l. Terms shown.** Which terms must the creator see before we send `tnc_accepted` [R8]?
- **m. Instant Settlements.** Do they respect `on_hold` [R18]?
- **n. Overseas creators.** Is there any product for paying creators outside India? None was found [R25], [R26].
- **o. Refunds.** How long is a refund idempotency key valid [R30], and what fields does the refund list return [R33]?
- **p. Disputes.** How long can a brand raise a dispute, and is the disputed amount held [R31]?

---

## 3. Phases

Each phase can be merged on its own and ships dark. Phases 3 and 4 are separate PRs, but `CREATORS_MARKETPLACE_ENABLED` is switched on only once both are in.

### Phase 1: Safety foundations (M, 2–3 days)

**Switch:** none needed. Every behaviour change is on the online-payment path, which production doesn't use while it is offline. The Route code has no callers until Phases 2 and 4. This phase fixes three existing bugs that would hit as soon as any online payment runs.

**Capture: claim the payment first (fixes the race and the stuck booking).**
- One transaction:
  1. `updateMany campaign_payments WHERE id AND status IN ('created','failed') → captured`. If 0 rows change, this is a duplicate event; return.
  2. Read the booking `FOR UPDATE`.
  3. If it matches, transition the booking, and in Phase 4 insert the `planned` payout rows carrying the **winning** `razorpay_payment_id`.
  4. If it doesn't match, record the payment as refund-due.
- Commit. Only then issue refunds or transfers. A failure rolls everything back, so Razorpay's retry runs again cleanly.
- Answer the webhook within 5 seconds [R28].

**Refunds.**
- Send `X-Refund-Idempotency` on every refund, with a stable key per item or payment (for example `rf-item-<itemId>`) [R30].
- Roll back our claim **only on a definite 4xx**. On status 0, a 5xx or a 409, keep `refund_pending` and reconcile through the payment's refund list [R33] (its fields are UNVERIFIED).
- New `campaign_refunds` ledger: one row per Razorpay refund, with origin `ours | external`.
- Every `refund.*` event re-reads the payment's refunds and sets `refundedPaise` to Razorpay's total. A refund we didn't issue is marked `external`, pauses every payout on that payment, and alerts staff. (Today `onRefundEvent` updates status only.)
- Delete the "refund from the Razorpay dashboard" error copy.
- **Reject** returns 409 if any item is live. Refunds are made per item, never "everything left".
- One **refundable** helper (captured − refunded − reserved) is used by `refundPaymentRow`, `capturedPaymentFor` and reject. An exported lock-and-claim helper makes the HTTP call only after the commit.

**Razorpay client** (`razorpay.ts`).
- Add PATCH and a v2 base URL.
- A 2xx response with an unreadable body raises a new **UNKNOWN** result: never success, never failure. (`res.json().catch(() => ({}))` sits on the success path today.)
- Errors from v2 `/accounts` calls are scrubbed **at source**.
- Every Route response is parsed into an allow-list of fields and the raw body is dropped. Razorpay echoes back `legal_info.pan`, `kyc.pan` and `settlements.account_number` [R5], [R6], [R29].
- Never log a request or response body.

**Webhooks.**
- New handlers: `transfer.processed`, `transfer.failed`, `settlement.processed`, `product.route.*` and `payment.dispute.*` [R22], [R32]. The dispute event names beyond created and lost are UNVERIFIED.
- The handlers **always store the event and return 2xx**. Razorpay disables a webhook that keeps failing for 24 hours, and this endpoint also marks brand payments paid [R28].
- Status changes apply only when the event's transfer id equals the row's current transfer id, and only as forward moves from a fixed table. For example, `transfer.processed` can only move `transfer_requested` to `held`.
- Payloads we can't read raise an alert and are left to the reconciliation job.
- Route events are subscribed in the dashboard **only after** this code is deployed. Today, unhandled events are stamped processed and lost.

**Other pieces.**
- `scrubPayoutSecrets()` masks digit runs of 5–20 (Razorpay accepts account numbers of 5 to 20 characters [R29]) and PAN-shaped and IFSC-shaped strings.
- DDL: every table in the data model at the end, created empty.
- CI guard scoped to `apps/api/src` and `apps/creators/src`. It matches property shapes (`\bpan\s*:`, `"pan"`, `account_number`, `ifsc_code`), excluding the Razorpay client and the bank-form validator. A bare `pan` would match existing jobs/internal code.
- **Creators app copy cleanup:** the "Now" row in section 5.

**Tests:**
- concurrent `payment.captured` + `order.paid` never refund;
- a forced failure after the claim leaves the booking movable on retry;
- a refund timeout never leads to a second refund;
- an external refund is detected;
- every Route handler is idempotent and ignores out-of-order events;
- the scrubber masks PAN, IFSC and 5–20 digit numbers.

### Phase 2: Bank connect (M, 3–4 days)

**Switch:** `CREATOR_ROUTE_ENABLED`. Built and tested with test keys; going live needs Route approved.

**Gates.**
- POST and PUT: `requireCreatorsEnabled`, `authenticateCreator`, an **approved** creator with a **verified email**, and a global daily cap on account creations (`CREATOR_PAYOUT_ACCOUNT_DAILY_CAP`). Today `requireActiveCreator` only blocks suspended creators.
- GET needs only `authenticateCreator`, so a suspended creator can still see their status.

**Form fields:**
- name exactly as on the PAN;
- PAN (4th character "P");
- phone (8–15 digits);
- the account's verified email (mandatory);
- account number (5–20 characters);
- IFSC;
- address (an Indian state from Razorpay's list, 6-digit PIN);
- consent to the creator terms and to Razorpay's terms. Which Razorpay document is UNVERIFIED (question l).

Sources: [R5], [R6], [R29]. Eligibility is "has a PAN and an IFSC account". `country = 'IN'` is only a hint, so NRIs with an Indian account are not turned away. Razorpay's validation is the final check.

**The four calls:**
1. create the account (`type:"route"`, `business_type:"individual"`, `reference_id` = creator id once `route_code_support` is enabled);
2. add the stakeholder;
3. request the Route product;
4. set the settlement bank details.

Sources: [R5], [R6], [R8], [R29]. Each Razorpay id is saved as soon as its call succeeds, and setup resumes from `setup_step` (a second account would fail Razorpay's duplicate check [R2]). Sensitive fields are re-entered on resume.

**A returning creator.** If Razorpay answers "Merchant email already exists for account – acc_X" [R5], we adopt `acc_X` only when our verified email equals that account's email and no other creator row is mapped to it.

**What we store:** Razorpay ids, status, requirement field references and reason codes, and a masked hint ("HDFC ••••1234"). We **never** store the account number, PAN, full IFSC, name or address. `auditLog` is never mounted on these routes, and `errorHandler` must not print Razorpay error objects raw.

**Activation.** Razorpay sends no notification when an account activates or fails verification [R2] (FAQ Penny Testing Q11–12). So a 5-minute cron polls, with the `product.route.*` webhooks only as accelerators. `bookable_after = activated_at + 24h`, the conservative reading given [R9] vs [R7].

**Changing bank details.** Razorpay says a change needs a support request [R2] (Q7); whether `PATCH` [R29] works is UNVERIFIED.
- The creator asks in the portal (signs in again; we email the verified address).
- Staff raise the Razorpay ticket.
- **Releases for that creator are paused** until Razorpay shows the new details, plus 72 hours.

**Closing an account.** Blocked while any offer is open. Payouts already held or released keep reconciling. Terms §11 is amended to match.

**UI:**
- creators app `/payouts` page (form, consent, status card); the route is added to `PRIVATE_ROUTES` and the nav; a dashboard checklist item;
- internal "Payout account" panel on `/creators/[id]`.

**Tests:**
- resume at each failure step without creating a duplicate account;
- after setup, **no column of any table, including `audit_logs`, contains the submitted account number or PAN**, and `console` never receives them;
- a draft or in-review creator gets 403;
- creators cannot read each other's accounts;
- the daily cap holds;
- the product poll never persists `account_number`.

### Phase 3: Minimal creator bookings (L, 6–8 days)

**Switch:** `CREATORS_MARKETPLACE_ENABLED`. It has no effect without the Route switch and the keys. **Start only after Route is approved (prerequisite 2).**

**Rate cards.**
- Add a `creator_asset` target type with `creator_rate_terms.share_bps`: at most 9000 (90%), with `ON DELETE CASCADE` from the rate card.
- A share is refused if it would produce a payout below ₹100 at the card's lowest price (question f).
- **Two lists:**
  - "staff-priceable": the creator is approved and the page is enabled;
  - "client-bookable": also needs an activated payout account past `bookable_after`, both switches on and the keys present.
- `listRateCardGrid` excludes creator targets.
- Suspending a creator, or a change to their payout account, sets their cards inactive and clears the catalogue cache.

**Payer-payee transparency.** The creator is **named as the provider** of each post in the client catalogue, review, checkout and receipt [R1].

**Checkout.**
- A booking with a creator item can use online payment only. Otherwise checkout returns 409; it never falls back to offline.
- Checkout re-checks that each creator page is still bookable.
- It freezes into `pricingSnapshot` per creator item: `creatorId`, `payoutAccountId`, `share_bps`, `gross`, `tds`, `amount`, and the page name and handle.

**Approve.**
- Creates offers only when the booking has `paidAt` and payout rows.
- Refuses when the posting window has already ended, and warns when less than 24 hours remain.
- The offer expires at `min(offered + CREATOR_OFFER_TTL_HOURS, end of launchTo in IST)`.

**New item statuses `awaiting_creator` and `refund_due`.** They are neither live nor settled. Update every status list and label in shared, the API, client `_ui.tsx` and internal `_ds.tsx`.

**Offer transitions.** Each is one conditional `updateMany` under `lockBooking`:
- accept: `offered` → `accepted`, only while `expires_at > now`;
- expire: `offered` only;
- withdraw: `offered`, or `accepted` with no link submitted;
- link: needs `accepted`, a held payout and the item in `manual_pending`.

`refundItem` and withdraw claim the item or offer **before** they reverse.

**Creator API.** Responses are built from an explicit allow-list. They never include the brand's price, the booking total or client contact details, and they are scoped by creator (another creator's offer returns 404).

**Link submission.**
1. The host must match the platform.
2. **Ownership check:** read the creator's own media through their live connection (IG `/{ig-id}/media?fields=permalink,timestamp`, FB `/{page}/published_posts?fields=permalink_url`), match by canonical key, and require a timestamp inside the posting window.
   - Live-probe both platforms before relying on this; the CLAUDE.md FB reel dual-id trap applies.
3. If the token has lapsed, staff tick "ownership checked" by hand and the item gets a hold of at least one day.

**Staff actions.**
- "Verify link & release" wraps `markPosted`. On a creator item, `markPosted` requires an accepted offer, a link the creator submitted, and an ownership check that passed (automatic or ticked).
- `markFailed` is **refused** on creator items; staff use Withdraw instead, which reverses and then refunds.

**Missed window.** A job finds accepted offers with no link by the end of `launchTo` plus 24 hours. It alerts staff, then runs the withdraw path: reverse, refund, `afterItemChange`.

**Page take-over and purge.**
- At capture and at approve, compare the frozen `creatorId` with the page's current owner. If they differ, no transfer is made and the item is refunded.
- Take-over is refused while a page has open offers or unsettled payouts, and a take-over clears the rate-card share.
- `purgeCreatorPageData` skips assets and connections with open offers or unsettled payouts.
- No foreign key from offers or payouts to `creator_assets`; the page name is snapshotted instead.

**The brief** includes the disclosure instruction, because the creator posts by hand (terms §7).

**Tests:**
- non-bookable pages never appear for clients or at checkout;
- `awaiting_creator` neither completes nor settles a booking;
- staff cannot post a creator item without the creator's consent and link;
- creators are isolated from each other;
- expiry and missed-window run the decline path;
- a take-over between checkout and capture refunds the item;
- the purge keeps booked pages;
- an offline checkout with a creator item returns 409.

### Phase 4: The Route money leg (L, 5–7 days)

**Payout states.**

| State | Meaning |
|---|---|
| `planned` | Row created in the capture transaction |
| `transfer_requested` | Razorpay was called. With no transfer id, the result is unknown. With an id, Razorpay reports `created` or `pending` [R10]. |
| `held` | Only once Razorpay reports `processed`, `on_hold:true` and no `on_hold_until` [R11]. If it is processed but not on hold, send `PATCH on_hold:true` and alert. |
| `release_requested` → `released` | Release claimed, then confirmed |
| `settled` / `settlement_failed` | `recipient_settlement.status` `processed` or `failed` [R21] |
| `reversal_requested` → `reversed` | Reversal claimed, then confirmed |
| `failed` | Definite rejection from Razorpay |
| `needs_attention` | Unknown result after the retry cap, or a duplicate transfer found |
| `manual_required` → `paid_manual` | Route cannot pay; staff pay by bank transfer |
| `void` | Never transferred |

A `paused_at` overlay sits on top of any state.

**Transfers.**
- Started fire-and-forget after the capture commit, with the cron as backstop. The webhook must answer within 5 seconds [R28], so the copy says "within minutes".
- Body: `{account, amount, currency:"INR", on_hold:true, notes:{payout_id, booking_item_id}}` [R11]. No brand price, no `linked_account_notes` [R21].
- **Unknown results.** No idempotency key exists for transfers made from a payment [R3]. So:
  - retry only after two listings of `GET /v1/payments/:id/transfers` at least N minutes apart both show no transfer carrying this `payout_id`;
  - at most **one** automatic retry, then `needs_attention`;
  - if a duplicate `payout_id` is found, reverse the extra transfer while it is still on hold.

**Release.** Only when all of these hold:
- the payout is `held` and `paused_at` is null;
- `creatorPayouts.release` is on;
- the offer is accepted, the creator submitted the link, ownership was checked and staff verified it;
- the item is live;
- the booking is not rejected;
- the payment has no open dispute;
- no bank change is pending for the creator;
- `release_after` ≤ now;
- **a fresh fetch** shows `processed`, `on_hold:true` and `amount_reversed:0`.

The claim is `updateMany WHERE status='held' AND paused_at IS NULL`. The destination hint is frozen onto the payout at release.

**Reversal.**
- The amount is always explicit: `transfer.amount − amount_reversed`, read fresh [R16].
- A definite 4xx puts the payout back in `held` and alerts staff. A timeout or 5xx stays `reversal_requested`, reconciled through `GET /v1/transfers/:id/reversals` [R3].
- Idempotent: an already-reversed payout returns success.
- Never use `reverse_all`. It reverses every transfer on the payment, other creators' shares included [R14].

**Reverse before refunding.** This applies to `refundItem`, reject, decline, expire, withdraw and the missed window. Each claims its item or offer first, then reverses, then refunds that item with an idempotency key.

**Reject** becomes a re-runnable sequence that needs no schema change:
1. Refuse if any item is live, any creator link is submitted, or any payout is past `held` or still `transfer_requested`.
2. Withdraw every offer, which closes the accept race.
3. Void `planned` and `failed` payouts.
4. Reverse each held payout.
5. Transition the booking only once every creator payout is reversed or void.
6. Refund per item.

If a step fails, staff see the partial state and the button resumes from there.

**When refunds are allowed.** "You cannot request a transfer on payment once a refund has been initiated" [R4]. So:
- no refund runs while any payout on that payment is `planned` or `transfer_requested`; those items wait as `refund_due` and the cron refunds them once allowed;
- once any refund exists on a payment, a failed transfer goes straight to `manual_required`, with Retry disabled.

**Reserved amount.** For a payment, it is the item price of every creator item whose payout is not `reversed` or `void`. A creator item's price is refundable only after its payout is reversed or void.

**Disputes.** On `payment.dispute.created` [R32], pause every payout on that payment.
- A held payout stays held.
- A released payout that hasn't settled is re-held with `PATCH on_hold:true` (UNVERIFIED, question d), or reversed while settlement is still `pending` [R17]. Staff are alerted.
- A lost dispute is debited from our balance [R31].

**Manual fallback.** `manual_required` → `paid_manual` only if one of these is true:
- no transfer was ever created;
- a fresh fetch shows `failed` and the payment lists no other active transfer carrying this `payout_id`;
- the payout is `reversed`.

If an account is suspended while holding money, reverse first, then pay by hand.

**Reconciliation cron.** Every 5 minutes, overlap guard claimed before the first await, at most 20 Razorpay calls per tick. Jobs:
1. execute `planned` payouts;
2. resolve unknown transfers;
3. confirm the hold;
4. clean up duplicates;
5. release payouts that are due;
6. re-read stale releases;
7. poll settlements **from the moment of release** (list endpoint with `expand[]=recipient_settlement` [R21]);
8. resolve reversals;
9. re-fetch every `held` row daily, to catch dashboard actions;
10. issue `refund_due` refunds;
11. reconcile refunds;
12. refresh account activation;
13. expire offers and handle missed windows;
14. send alerts: immediately for `failed`, `settlement_failed`, failed reversals, external refunds, disputes and suspended accounts holding money; daily digest for anything past its threshold.

Alerts use the existing IPv4 mailer and respect the Gmail caps.

**`paidAt` stays webhook-only.** Payout code never writes it.

**Tests (DB-backed, Razorpay faked):**
- one transfer per item under duplicate capture events;
- a timeout followed by a late listing ends with exactly one transfer;
- an unknown reversal never ends in `held`;
- a failed reversal means no refund and no change;
- a refund waits while transfers are pending;
- an external refund pauses payouts;
- a dispute pauses payouts;
- a release-vs-reversal race (also in `tests-concurrency`);
- a release refused when the fresh fetch shows a reversal;
- `settlement_failed` raises an alert;
- payout ≤ item price, including entertainment pricing and the audio add-on;
- `paidAt` is untouched.

### Phase 5: Tracker and portal UI (M, 3–5 days)

`creatorTrack()` in `packages/shared/src/creator/track.ts` is pure, computed by the server and tested through the apps/api suite.

| Stage | Done when | Creator copy |
|---|---|---|
| Brief | Offer accepted | Brand, page, format, window (IST), files, caption, disclosure, **₹X after TDS**, accept-by date. Shows "₹X set aside for you" only when the payout is `held`. |
| Campaign | Item live | "Post between {from} and {to}." |
| Delivered link | Ownership checked and staff verified | "Link received — we're checking it" → "Live: {link}" |
| Payment progress | `released` | "Brand paid ✓ · Set aside ✓ · Released {date} — usually reaches your bank within 2 working days" |
| Paid | `settled` | "Paid ₹X · included in bank payout UTR {utr} on {date} to {hint frozen at release}" |

**Failure and void copy:**
- Void bars: "No payment is due — ₹X **is being returned** to the brand", changing to "went back" once the refund is processed.
- `settlement_failed`: "Your bank rejected the payment — contact us to update your details."
- `failed` or `manual_required`: "We'll pay you by bank transfer."
- Paused: "Your payout is paused — contact us."

**Never** show "Paid" on `transfer.processed`.

**Creators app:** `/bookings` and `/booking?id=` (added to `PRIVATE_ROUTES`), dashboard totals, SWR polling at 60 s on the detail page until the bar reaches Paid.

**Internal portal:**
- the bar and actions on `/campaigns/[id]`;
- a `/campaigns/payouts` queue with a formula-guarded CSV;
- a rate editor preview: "Creator gets ₹X · we keep ₹Y before Razorpay fees" [R19], [R20].

**Copy ships in the go-live PR** (section 5).

**Tests:** `creatorTrack()` table test across every combination of states; layouts checked headless at 390 px and 1280 px.

### Phase 6: Rehearsal and go-live (S code; the time goes on the rehearsal)

1. Apply the DDL as the `dashmani` role before merging, and confirm zero drift.
2. Deploy with every switch off.
3. **Test mode on a local stack.** Run every path:
   - onboard → capture → held → verify → release → settled;
   - decline, expiry, missed window, reject;
   - a refund waiting on a pending transfer;
   - a timeout, then adoption of the transfer;
   - a dispute.

   Penny testing works in test mode [R2]. Other linked-account behaviour in test mode is UNVERIFIED.
4. Production: set the keys and **keep `CAMPAIGN_PAYMENT_MODE=offline`** for network-only bookings. Then subscribe the webhook events.
5. Turn on `CREATOR_ROUTE_ENABLED`. Onboard **one** real Indian creator (never a staff Facebook identity) and confirm in the dashboard that Allow Refunds and Dashboard Access are off.
6. Run one small live booking end to end. Confirm the UTR **and the amount that reached the bank** (question c), and record the release-to-bank time.
7. Turn on `CREATORS_MARKETPLACE_ENABLED` and publish the go-live copy.

**Later, out of scope:**
- UPI destinations: ₹1 lakh per transaction and per day; needs enabling and name matching [R27].
- Instant Settlements: only after confirming they respect `on_hold` [R18].
- Creator-set prices and FX.
- API publishing on creator pages.
- International payouts.

**Total:** about 20–29 developer days. Route approval (5–7 business days) runs in parallel with Phases 1–2.

### Switches

| Switch | Where | Default | Effect |
|---|---|---|---|
| `CREATORS_ENABLED` | env | off | Existing: the whole creator API |
| `CREATOR_ROUTE_ENABLED` | env | off | Bank connect and **new** transfers. Off never strands money: existing payouts keep reconciling. |
| `CREATORS_MARKETPLACE_ENABLED` | env | off | Creator pages in the catalogue, and offers. Needs the Route switch and the keys. |
| `CREATOR_PAYOUT_CRON_ENABLED` | env | 1 | Reconciliation, release and expiry |
| `creatorPayouts.release` | `system_settings` | on | Runtime pause of all releases, no restart |
| `CREATOR_PAYOUT_HOLD_DAYS` | env | 0 | Extra days between verification and release. At least 1 when ownership was checked by hand. |
| `CREATOR_OFFER_TTL_HOURS` | env | 48 | Offer expiry, capped at the end of the posting window |
| `CREATOR_PAYOUT_ACCOUNT_DAILY_CAP` | env | 50 | Linked-account creations per day |
| `CAMPAIGN_PAYMENT_MODE` | env | offline | Applies to network-only bookings. Creator bookings are always online. |

**Fees:** 0.25% + GST per transfer, paid by us, plus the gateway fee on the full payment [R19], [R20]. Whether a settlement fee is taken from the creator is UNVERIFIED (question c).

---

## 4. Open decisions

1. **When to release, and who carries chargeback risk.**
   - Recommended: release as soon as staff verify a post whose ownership was checked automatically (`HOLD_DAYS=0`), with at least one day's hold when ownership was checked by hand.
   - Pause payouts on any dispute.
   - Accept card chargeback risk as a cost at launch, and review it after the first 20 bookings. A lost dispute is debited from us [R31].
   - Fallback if it bites: limit creator-booking checkout to UPI and netbanking.
2. **How the creator's pay is set.**
   - Recommended for this phase: staff set a share per page (at most 90%, payout at least ₹100), and the creator sees the exact ₹ amount before accepting.
   - ⚠ This **replaces the recorded owner decision "the creator sets the price"** (CLAUDE.md, Creator portal → Owner decisions) until creator-set prices ship. It needs explicit owner approval, and terms §5 and the landing page change with it.
3. **Online payment only for creator bookings.**
   - Recommended: yes. Without a Razorpay capture, Route has nothing to move [R11].
   - Network-only bookings stay offline.
4. **Creators outside India.**
   - Recommended: anyone can sign up and connect pages, but paid bookings need a PAN and an Indian bank account.
   - Show this **at sign-up, before Facebook is connected**.
   - Overseas payouts (SWIFT, with 195/15CA/15CB and GST reverse charge, all UNVERIFIED) are a separate project.
5. **Tax, invoicing and PAN.**
   - Recommended: no live transfers until an accountant signs off. `tds_bps` defaults to 0.
   - If TDS applies, fetch the PAN from Razorpay's stakeholder record (`kyc.pan`, [R6]) at filing time through a staff-only path, and store nothing.

---

## 5. Honest landing-page wording, by phase

Lines to change today:
- `apps/creators/src/app/page.tsx:14-15` and `:36`;
- `signup/page.tsx:123`;
- `components/auth/shared.tsx:49`;
- terms §1 (`:20`), §5 (`:50`, `:52`), §7 (~`:62`), §8 (`:69-75`), §11 (`:93`);
- privacy (`:53`).

| When | May claim | Must not claim | Wording |
|---|---|---|---|
| **Now (Phase 1 copy cleanup)** | Sign up, connect pages, our team reviews you | Prices you set, "your own currency", payouts of any kind, "direct", "worldwide" pay | "Join the Digital Sukoon creator network. Connect your Facebook Page or Instagram professional account and our team reviews it. **Paid bookings are coming soon.** Anyone can join; paid bookings will need a PAN and an Indian bank account." The same India line appears on sign-up before Facebook connect. "You name your asking price … in your own currency" and "Creators worldwide" are removed. |
| **Phase 2 live** (bank connect on, no bookings) | You can add your bank through Razorpay now | Bookings, payment timing | "Add your bank account now so you're ready when paid bookings open. Your PAN and bank details go straight to Razorpay; we keep only a masked reference." |
| **Phases 3–5 merged, switches off** | No change | — | — |
| **Go-live** (after the first real UTR, Phase 6 step 7) | The direct-payout pitch, India only | "Directly from the brand", "instant" or "same day", "no fees" (until question c is answered), "guaranteed", "paid worldwide", "you set your price" (unless decision 2 says so) | **"No more chasing agencies for payment. Brands pay Digital Sukoon up front through Razorpay, before you even accept. Your share moves into a Razorpay account in your name and is held there. Once we've checked your post, we release it and Razorpay pays your bank — usually within 2 working days. Track every step: brief, campaign, link, payment, paid."** Footnote: "Paid bookings need a PAN and an Indian bank account. If a booking is cancelled before you post, no payment is due." Terms §1/§5/§7/§8/§11 rewritten, `termsVersion` bumped, acceptance recorded at bank connect. |
| **Later** (after measuring 20+ payouts) | A measured figure | Any figure we haven't measured | "Most creators are paid within N working days of their post going live." |

---

## Appendix A: what happened to each review finding

**Accepted as written:**
- Money review: F1–F5, F7, F9–F14.
- Compliance review: 1, 2, 4–7, 9–18. Citation fixes: the IFSC rule now cites [R7]/[R29]; penny-test timing and duplicates cite [R2]; the 24-hour webhook retry cites [R28] only; "transfers cannot follow a refund" cites [R4] only.
- Feasibility review: 1–18.

**Accepted with a change** (each one line):
- **Money F6:** the reserve is the creator item's **price**, not `gross_paise`. A delivered creator item should never be refundable at all, which also protects our cut and any TDS.
- **Money F8:** bank changes are staff-mediated, because Razorpay requires a support request [R2] (Q7). The 72-hour release pause still applies.
- **Money F15:** the floor is ₹100, not 100 paise, until Razorpay clears up its own contradiction [R11]. It is enforced at rate-card time rather than discovered at transfer time.
- **Compliance 3:** the default is to fetch the PAN from Razorpay at filing time rather than keep it encrypted, which keeps "we store no PAN" true.
- **Compliance 8:** we keep one webhook URL, with every handler storing the event and returning 2xx. A separate Route URL and secret stays an option, not a requirement.
- **Feasibility 17:** dashboard access stays off at launch rather than explaining held money in the copy.

**Rejected:** none.

## Appendix B: data model

Additive DDL only, in a new `scripts/creator-payouts-ddl.sql`, applied by hand as the `dashmani` role **before merging**, using a copy of the creators apply helper. Never run `db push`. CI rehearses the script twice. Add the tables to the `ci.yml` DROP and script lists and to the `tests/setup.ts` TRUNCATE list. No ALTER on `creators`, `campaign_bookings` or `campaign_booking_items`; the new item statuses fit the existing VARCHAR.

| Table | Key columns |
|---|---|
| `creator_payout_accounts` | `creator_id` UNIQUE; `razorpay_account_id` UNIQUE; stakeholder id; product id; `setup_step`; `activation_status`; `requirements` (field references and reason codes only); `destination_hint`; terms version and acceptance time; `tds_bps`; `activated_at`; `bookable_after`; `bank_change_requested_at`; `bank_change_cleared_at`; `last_error` (scrubbed) |
| `creator_rate_terms` | `rate_card_id` UNIQUE, FK CASCADE; `share_bps` CHECK 0–9000 |
| `creator_offers` | `booking_item_id` UNIQUE; `creator_id`; `creator_asset_id` (no FK) plus page name and handle snapshot; `status`; `payout_paise`; `expires_at`; `link_submitted_at`; `ownership_check` (`auto_ok`/`auto_failed`/`manual_ok`) and who checked; `link_verified_at` and by whom; `post_missing_at`; `creator_note` |
| `creator_payouts` | `booking_item_id` UNIQUE; `razorpay_payment_id` (the capture winner); `status`; `paused_at` and reason; `item_price_paise`; `gross_paise`; `tds_paise`; `amount_paise`; `razorpay_transfer_id` UNIQUE; `transfer_status`; `settlement_status`; `on_hold_verified_at`; `amount_reversed_paise`; `recipient_settlement_id`; UTR; `destination_hint` (frozen at release); release, settle and reverse timestamps; attempts; manual reference fields |
| `creator_payout_events` | Append-only audit of every money state change (notes scrubbed) |
| `campaign_refunds` | `razorpay_refund_id` UNIQUE; payment; item; amount; receipt; `idempotency_key` UNIQUE; status; origin (`ours` / `external`) |
| `campaign_disputes` | `razorpay_dispute_id` UNIQUE; payment; amount; status; opened and closed times |

## Sources

All Razorpay `llm-docs` pages are Razorpay's own mirror. Pages under `/docs/` redirect visitors outside India to a 404. Copies read for this plan are in the scratchpad `rp/` folder.

| Key | URL |
|---|---|
| R1 | https://razorpay.com/docs/build/llm-docs/payments/route.md |
| R2 | https://razorpay.com/docs/build/llm-docs/payments/route/faqs.md |
| R3 | https://razorpay.com/docs/build/llm-docs/api/payments/route.md |
| R4 | https://razorpay.com/docs/build/llm-docs/payments/route/integration-guide.md |
| R5 | https://razorpay.com/docs/build/llm-docs/api/payments/route/create-linked-account.md |
| R6 | https://razorpay.com/docs/build/llm-docs/api/payments/route/create-stakeholder.md |
| R7 | https://razorpay.com/docs/build/llm-docs/payments/route/linked-account.md |
| R8 | https://razorpay.com/docs/build/llm-docs/api/payments/route/request-product-config.md |
| R9 | https://razorpay.com/docs/build/llm-docs/payments/route/transfer-funds-to-linked-accounts.md |
| R10 | https://razorpay.com/docs/build/llm-docs/api/payments/route/transfers-entity.md |
| R11 | https://razorpay.com/docs/build/llm-docs/api/payments/route/create-transfers-payments.md |
| R13 | https://razorpay.com/docs/build/llm-docs/api/payments/route/modify-settlement-hold.md |
| R14 | https://razorpay.com/docs/build/llm-docs/api/payments/route/refund-payments-and-reverse-transfer.md |
| R16 | https://razorpay.com/docs/build/llm-docs/api/payments/route/reverse-a-transfer.md |
| R17 | https://razorpay.com/docs/build/llm-docs/payments/route/schedule-settlement.md |
| R18 | https://razorpay.com/docs/build/llm-docs/payments/settlements/instant/route.md |
| R19 | https://razorpay.com/docs/build/llm-docs/payments/route/pricing.md |
| R20 | https://razorpay.com/docs/build/llm-docs/payments/route/transfer-fees-example.md |
| R21 | https://razorpay.com/docs/build/llm-docs/api/payments/route/fetch-settlement-details.md |
| R22 | https://razorpay.com/docs/build/llm-docs/webhooks/route.md |
| R23 | https://razorpay.com/terms/ |
| R24 | https://razorpay.com/docs/payroll/tax-verifications/tax-codes.md |
| R25 | https://razorpay.com/docs/build/llm-docs/x/payouts.md |
| R26 | https://razorpay.com/blog/razorpay-rbi-cross-border-licence-global-payments/ |
| R27 | https://razorpay.com/docs/payments/route/linked-account/vpa-settlements.md |
| R28 | https://razorpay.com/docs/webhooks/best-practices.md |
| R29 | https://razorpay.com/docs/build/llm-docs/api/payments/route/update-product-config.md |
| R30 | https://razorpay.com/docs/build/llm-docs/api/refunds/normal-refunds-idempotent.md |
| R31 | https://razorpay.com/docs/build/llm-docs/payments/disputes.md |
| R32 | https://razorpay.com/docs/build/llm-docs/payments/disputes/subscribe-to-webhooks.md (cited by a reviewer; not read by me; event names UNVERIFIED) |
| R33 | https://razorpay.com/docs/build/llm-docs/api/refunds/fetch-multiple-refund-payment.md (not read; fields UNVERIFIED) |
| R35 | https://cleartax.in/s/section-194o (secondary source, UNVERIFIED against the law) |

The original Phase B/C plan is `/root/.claude/plans/plan-in-start-campaign-replicated-neumann.md`.