# Creator payouts: what the owner has to do (outside the code)

Companion to `2026-10-12-creator-payouts-razorpay-route.md`. The code ships dark, phase by
phase. **Nothing here can be done by the code.** The items in section 1 have waiting times, so
start them now.

## 0. Defaults adopted when the build started (2026-10-17)

The owner said "go ahead with the plan" after these defaults were listed. Change any of them
before Phase 3 and the build follows.

| Decision | Default being built |
|---|---|
| When to release the money | When staff verify the post, with at least one day's hold if ownership was checked by hand. Any dispute pauses the payout. Card chargeback risk is accepted at launch and reviewed after the first 20 bookings. |
| How the creator's pay is set | Staff set a share per page (at most 90%, payout at least ₹100). The creator sees the exact ₹ amount before accepting. **This replaces the earlier "creator sets the price" decision until creator-set prices ship.** |
| Payment mode for creator bookings | Online (Razorpay) only. Network-only bookings can stay offline. |
| Creators outside India | Can sign up and connect pages. Paid bookings need a PAN and an Indian bank account, and the sign-up page says so. |
| Tax | No live transfers until the accountant signs off. `tds_bps` defaults to 0. |

## 1. Start now (these have waiting times)

1. **Razorpay merchant account for Dashmani Media Pvt Ltd**: KYC complete, live and test keys, a webhook secret. If one already exists, only the keys are needed.
2. **Route activation** (Razorpay support or your account manager; review takes 5–7 business days). Razorpay needs:
   - domestic turnover above ₹40 lakh (GST-3B, FY25 or FY26) or export turnover above ₹5 lakh (bank FIRC); a self-declaration is accepted if you are GST-exempt or in your first year;
   - a **written payer-payee transparency confirmation**: the creator, named as the provider of each post, deals directly with the brand's customers.
   This is the go/no-go gate. Phase 3 does not start until it is approved.
3. **Ask Razorpay to enable**: creating linked accounts by API (otherwise "Marketplace feature is not enabled for merchants using private auth"), `route_code_support` (needed to send `reference_id`), and penny testing for new linked accounts.
4. **Account policy for every creator account**: "Allow Refunds" **off** (a linked account must never refund a brand from the creator's balance) and "Dashboard Access" **off** at launch.

## 2. Questions for Razorpay (send as one email; answers decide the settings marked in the plan)

- **a. Payer-payee transparency.** Does our flow qualify? The brand books through our staff, the transfer is made before the creator accepts that particular booking (after they accepted our terms), and the creator posts.
- **b. Cooling period.** Is there a 24-hour cooling period before a new linked account can receive transfers, or is it activated immediately?
- **c. Settlement timing and fees.** After a hold is released, does the creator's bank get paid the next working day or in 2 working days? Is any fee deducted from the creator's settlement?
- **d. Reversals and re-holding.** Does reversing a held, unsettled transfer always succeed? Can `PATCH on_hold:true` re-hold a released transfer that has not settled?
- **e. Late transfers and hold length.** Can a transfer be created from a payment days after capture? Is there a maximum hold length?
- **f. Minimum transfer.** The error text says 100 paise; the fix line on the same page says ₹100. Which is it?
- **g. Webhook payloads.** What do `transfer.processed` and `transfer.failed` contain? Whose `account_id` does `settlement.processed` carry?
- **h. Changing bank details.** Can it be done with `PATCH`, or only through a support request?
- **i. Category.** Which category and subcategory fit creators (media_and_entertainment, or services → ad_and_marketing)?
- **j. Fees.** Are reversed transfers charged? Is the 0.25% transfer fee negotiable?
- **k. Manual fallback.** Can our staff read a linked account's full bank details in the dashboard?
- **l. Terms shown.** Which terms must the creator see before we send `tnc_accepted`?
- **m. Instant Settlements.** Do they respect `on_hold`?
- **n. Overseas creators.** Is there any product for paying creators outside India?
- **o. Refunds.** How long is a refund idempotency key valid, and what fields does the payment's refund list return?
- **p. Disputes.** How long can a brand raise a dispute, and is the disputed amount held?

## 3. Accountant (before any live transfer)

- The TDS section and rate (194-O or 194C / 194J; new section codes from 1 April 2026). Razorpay mentions 194-O only for merchants outside India.
- Whether TDS is due when we credit the linked account at capture or when we release.
- GST §52 TCS, GST on our cut, and who invoices whom.
- Whether we must keep the creator's PAN. The build stores none: if TDS applies, the PAN is read from Razorpay's stakeholder record at filing time through a staff-only path.

## 4. Legal copy (before go-live)

- Creator terms §1, §5, §7, §8 and §11 rewritten for payouts, and `termsVersion` bumped. Razorpay's own terms (clause 2.22) require a contract with every seller we collect for; the creator terms accepted at bank connect are that contract.
- Client terms: creator bookings are paid up front, the creator is named as the provider, and the refund policy.
- Privacy policy: Razorpay receives the creator's PAN, bank details and address; link to Razorpay's policy.

## 5. Go-live rehearsal (Phase 6; needs the items above)

1. Apply each phase's DDL on production as the `dashmani` role before merging (the helper scripts do this).
2. Deploy with every switch off.
3. Rehearse every path in Razorpay **test mode** on a local stack.
4. Production: set the keys, keep `CAMPAIGN_PAYMENT_MODE=offline` for network-only bookings, then subscribe the webhook events (`transfer.*`, `settlement.processed`, `product.route.*`, `payment.dispute.*`). Subscribe only after the code that handles them is deployed: unhandled events are otherwise stamped processed and lost.
5. Turn on `CREATOR_ROUTE_ENABLED`, onboard one real Indian creator (never a staff Facebook identity), and confirm Allow Refunds and Dashboard Access are off.
6. Run one small live booking end to end. Confirm the UTR **and the amount that reached the bank**, and record the release-to-bank time.
7. Only then turn on `CREATORS_MARKETPLACE_ENABLED` and publish the go-live copy.

The landing-page wording that may be used at each stage is in section 5 of the plan. Until step 6
has produced a real UTR, nothing may claim a payment timeline.
