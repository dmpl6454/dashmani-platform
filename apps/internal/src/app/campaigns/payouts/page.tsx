"use client";
import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronUp, Download, PauseCircle, RefreshCw } from "lucide-react";
import { downloadPayoutsCsv, setReleaseSwitch, useBookingPayouts, usePayoutQueue, useReleaseSwitch, type PayoutFilterKey, type PayoutRow } from "@/lib/hooks/use-creator-payouts";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { BTN_GHOST, BTN_RED, CARD, ErrorBar, PageHead, PlatformDot, fmtWhen, rupees } from "../_ds";
import { PAYOUT_CHIPS, RELEASE_SWITCH_TEXT, ageShort, ago, attentionCount, isPayoutFilterKey, lastEventText, payoutCounts, payoutInFilter, payoutViewOrder, releaseChangeLine, releaseOnOf, sortPayoutsForView, switchBars, type PayoutActionKey } from "../_payout";
import { ActionDialog, NoticeBar, PausedChip, PayoutActions, PayoutDetailView, PayoutHint, PayoutPill, ReleasePausedBanner, usePayoutDialog, type DialogSpec, type Notice } from "../_payout-ui";

// Creator payouts: the staff queue. Everything a person has to look at between "the client paid" and "the creator's bank was paid", and
// afterwards what became of it, by view, with the buttons that act on each payout. STAFF ONLY (Admin / Super Admin on the API): it shows what
// each creator earns.
//
// ⚠️ HONEST STATES. A failed load is never drawn as "no payouts": an error says so and offers Retry, and a view that really is empty
// says that. A payout counts as paid only when Razorpay has settled it (see _payout.ts), and the banner below says plainly when every
// release is paused. Every action opens a confirm dialog that says what it will do and shows the API's refusal inside it.
//
// ⚠️ THE KILL SWITCH DOES NOT DEPEND ON THE QUEUE LOADING. "Pause all releases" is read from its own light request and offered whenever
// releases are not known to be paused, including while the queue is still loading and after it failed: that is exactly when it matters.
//
// ⚠️ A CAMPAIGN'S QUEUE COUNTS ITS OWN PAYOUTS. The API's per-view counts are company-wide ("Showing 1 of 47" about a campaign with one
// payout, "Needs attention (5)" pointing at another campaign's work), so with ?booking= the page reads that campaign's payouts (at most 50
// posts, every state) and sorts them into the views itself, with the same rules as the API (payoutInFilter, held equal by a test).

const DEFAULT_FILTER: PayoutFilterKey = "needs_attention";
const ID_SHAPE = /^[0-9a-zA-Z-]{8,64}$/;

/** The two ways a person pauses or resumes EVERY release (the runtime switch). Takes effect on the next release, no restart. */
function releaseSwitchSpec(to: "on" | "off"): DialogSpec {
  return to === "off"
    ? {
        title: "Pause ALL releases?",
        confirm: "Pause all releases",
        busy: "Pausing…",
        danger: true,
        body: (
          <>
            <p>{RELEASE_SWITCH_TEXT.pauseDialog[0]}</p>
            <p className="text-ds-gold">{RELEASE_SWITCH_TEXT.pauseDialog[1]}</p>
          </>
        ),
        run: () => setReleaseSwitch("off"),
      }
    : {
        title: "Resume releases?",
        confirm: "Resume releases",
        busy: "Resuming…",
        body: (
          <>
            <p>The worker will release every held payout whose release is due, on its next run (every few minutes). Each is checked again first: the post verified, no dispute open, no bank change pending.</p>
            <p>Paused payouts (a dispute, a bank change, a staff pause) stay paused: this switch is only the global one.</p>
          </>
        ),
        run: () => setReleaseSwitch("on"),
      };
}

function emptyText(filter: PayoutFilterKey, scoped: boolean): string {
  const where = scoped ? " in this campaign" : "";
  switch (filter) {
    case "needs_attention":
      return scoped ? "Nothing needs attention in this campaign." : "Nothing needs attention right now.";
    case "open":
      return `There are no open payouts${where}.`;
    case "owed_after_reversal":
      return `No creator is owed money after a reversal${where}.`;
    case "finished":
      return `No payout has finished yet${where}.`;
    case "all":
      return `There are no payouts${where}.`;
    default:
      return `No payouts in this view${where}.`;
  }
}

export default function CreatorPayoutsPage() {
  usePageTitle("Creator payouts");
  const [filter, setFilter] = useState<PayoutFilterKey>(DEFAULT_FILTER);
  const [bookingId, setBookingId] = useState<string | null>(null);
  // The address bar says which view (and which campaign) to open; it is read once, after hydration, so the first request is the right one.
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [err, setErr] = useState("");
  const [csvBusy, setCsvBusy] = useState(false);
  const [switchDialog, setSwitchDialog] = useState<"on" | "off" | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const f = q.get("filter");
    const b = q.get("booking");
    if (isPayoutFilterKey(f)) setFilter(f);
    if (b && ID_SHAPE.test(b)) setBookingId(b);
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const q = new URLSearchParams();
    if (filter !== DEFAULT_FILTER) q.set("filter", filter);
    if (bookingId) q.set("booking", bookingId);
    const qs = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [ready, filter, bookingId]);

  const scoped = !!bookingId;
  // Exactly one of the two reads is on (a null key reads nothing).
  const queue = usePayoutQueue(filter, bookingId, ready && !scoped);
  const campaign = useBookingPayouts(ready && bookingId ? bookingId : null, "always");
  const sw = useReleaseSwitch();

  const first = queue.data?.[0];
  const last = queue.data?.[queue.data.length - 1];
  const loaded = scoped ? !!campaign.data : !!first;
  const error = scoped ? campaign.error : queue.error;
  const isLoading = scoped ? campaign.isLoading : queue.isLoading;
  const refresh = () => (scoped ? campaign.mutate() : queue.mutate());
  const everyPayoutOfCampaign = campaign.data?.rows ?? [];
  const rows: PayoutRow[] = scoped ? sortPayoutsForView(everyPayoutOfCampaign.filter((r) => payoutInFilter(r, filter)), filter) : (queue.data ?? []).flatMap((p) => p.rows);
  const counts = scoped ? (campaign.data ? payoutCounts(everyPayoutOfCampaign) : undefined) : first?.counts;
  const switches = scoped ? campaign.data?.switches : first?.switches;
  const releaseOn = releaseOnOf(sw.data?.release, switches?.release);
  const loadingMore = !scoped && queue.size > 0 && !!queue.data && typeof queue.data[queue.size - 1] === "undefined" && !queue.error;
  // A campaign has at most 50 posts, so its payouts fit one page of 200; if they ever did not, the numbers below would be a slice and must say so.
  const partial = scoped && !!campaign.data?.nextCursor;

  const open = counts?.open;
  const attention = attentionCount(counts);
  const chip = PAYOUT_CHIPS.find((c) => c.key === filter)!;
  const viewTotal = counts?.[filter];

  const { open: openAction, dialog } = usePayoutDialog({ onChanged: () => refresh(), onNotice: (n) => { setErr(""); setNotice(n); } });

  const pickFilter = (k: PayoutFilterKey) => {
    setFilter(k);
    setNotice(null);
  };

  const csv = async () => {
    setCsvBusy(true);
    setErr("");
    try {
      await downloadPayoutsCsv(filter, bookingId);
    } catch (e) {
      setErr(`The CSV couldn't be downloaded. ${e instanceof Error && e.message ? e.message : ""}`.trim());
    } finally {
      setCsvBusy(false);
    }
  };

  // Other views that have work waiting while this one is empty: say where it is (in this campaign's own counts when the page is scoped to one).
  const elsewhere = PAYOUT_CHIPS.filter((c) => c.attention && c.key !== filter && (counts?.[c.key] ?? 0) > 0);
  const bookingName = (scoped ? everyPayoutOfCampaign : rows).find((r) => r.bookingName)?.bookingName ?? null;

  const headerActions = (
    <>
      {/* Offered whenever releases are not KNOWN to be paused, loaded queue or not: an unknown state still needs the emergency stop. The PUT is idempotent. */}
      {releaseOn !== false && (
        <button type="button" className={BTN_RED} onClick={() => setSwitchDialog("off")}>
          <PauseCircle className="h-4 w-4" /> Pause all releases
        </button>
      )}
      <button type="button" className={BTN_GHOST} onClick={csv} disabled={csvBusy || !ready}>
        <Download className="h-4 w-4" /> {csvBusy ? "Preparing…" : "Download CSV"}
      </button>
    </>
  );

  return (
    <div className="pb-10">
      <Link href="/campaigns" className="mt-6 inline-flex items-center gap-1 text-[12.5px] text-ds-t3 hover:text-ds-text"><ChevronLeft className="h-4 w-4" />All bookings</Link>
      <PageHead
        title="Creator payouts"
        sub={!loaded ? (error ? "Couldn't load" : "Loading…") : `${scoped ? "This campaign: " : ""}${open ?? "—"} open · ${attention ?? "—"} need${attention === 1 ? "s" : ""} attention`}
        // PageHead's title block shrinks to nothing before it wraps, so the two buttons sit beside the title only where they fit (md and up)
        // and under it otherwise.
        right={<div className="hidden md:flex flex-wrap gap-2">{headerActions}</div>}
      />
      <div className="md:hidden flex flex-wrap gap-2 -mt-3 mb-4">{headerActions}</div>

      <div className="grid gap-3 mb-4">
        {releaseOn === false && <ReleasePausedBanner line={releaseChangeLine(sw.data)} onResume={() => setSwitchDialog("on")} />}
        {sw.error && !sw.data && (
          <div role="status" className="rounded-[8px] border border-ds-line2 bg-ds-inset px-3.5 py-2.5 text-[12.5px] text-ds-t2">
            Couldn&apos;t read whether releases are paused. &ldquo;Pause all releases&rdquo; still works.
          </div>
        )}
        {switchBars(switches).map((b) => (
          <div key={b.key} role="status" className="rounded-[8px] border border-ds-line2 bg-ds-inset px-3.5 py-2.5 text-[12.5px] text-ds-t2">{b.text}</div>
        ))}
        {notice && <NoticeBar notice={notice} onClose={() => setNotice(null)} />}
        {err && <ErrorBar message={err} onClose={() => setErr("")} />}
      </div>

      {/* Buttons that filter one list, not tabs: there is no tab keyboard model (arrow keys, roving focus) behind them, so they do not claim one. */}
      <div className="flex gap-1.5 flex-wrap items-center mb-2" role="group" aria-label="Payout views">
        {PAYOUT_CHIPS.map((c, i) => {
          const n = counts?.[c.key];
          const on = c.key === filter;
          const hot = c.attention && (n ?? 0) > 0;
          return (
            <Fragment key={c.key}>
              {i > 0 && c.group !== PAYOUT_CHIPS[i - 1].group && <span aria-hidden className="hidden sm:block h-5 w-px bg-ds-line2 mx-1" />}
              <button
                type="button"
                aria-pressed={on}
                onClick={() => pickFilter(c.key)}
                className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold border transition-colors ${on ? "border-ds-gold text-ds-gold bg-[rgba(233,189,98,.08)]" : "border-ds-line2 text-ds-t2 hover:text-ds-text"}`}
              >
                {c.label}{" "}
                {n !== undefined && (
                  <span className={`tabular-nums ${hot ? "inline-block min-w-[18px] px-1.5 rounded-full text-[11px] text-white bg-[#E5484D]" : "opacity-70"}`}>{n}</span>
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
      <p className="mb-4 text-[12.5px] text-ds-t3">{chip.blurb} {payoutViewOrder(filter) === "newest" ? "Newest first." : "Oldest first."}</p>

      {bookingId && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[8px] border border-ds-line2 bg-ds-inset px-3.5 py-2.5 text-[12.5px] text-ds-t2">
          <span className="min-w-0">Showing one campaign&apos;s payouts only, and counting only those{bookingName ? <>: <Link href={`/campaigns/${bookingId}`} className="text-ds-gold hover:underline break-words">{bookingName}</Link></> : null}.</span>
          <button type="button" className="text-ds-gold hover:underline" onClick={() => setBookingId(null)}>Show every campaign</button>
        </div>
      )}
      {partial && (
        <div role="status" className="mb-4 rounded-[8px] border border-ds-line2 bg-ds-inset px-3.5 py-2.5 text-[12.5px] text-ds-t2">
          This campaign has more payouts than one page holds. The numbers and rows here cover the newest 200.
        </div>
      )}

      {error && !loaded && (
        <div className="mb-4 grid gap-2.5" role="alert">
          <ErrorBar message="Couldn't load the payouts. This is a loading problem: it does not mean there are none." />
          {error instanceof Error && error.message && <p className="text-[12px] text-ds-t4 break-words">{error.message}</p>}
          <div><button type="button" className={BTN_GHOST} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> Try again</button></div>
        </div>
      )}
      {error && loaded && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <ErrorBar message="Couldn't refresh. What's shown is the last read, so it may be out of date." />
          <button type="button" className="text-[12.5px] text-ds-gold hover:underline" onClick={() => void refresh()}>Try again</button>
        </div>
      )}

      <section className={`${CARD} overflow-hidden`} aria-label={chip.label}>
        {(!ready || (isLoading && !loaded)) && !error && <div className="py-14 text-center text-ds-t3 text-[13px]">Loading…</div>}
        {loaded && rows.length === 0 && (
          <div className="py-14 px-5 text-center text-[13px]">
            <div className="text-ds-t2">{emptyText(filter, scoped)}</div>
            {elsewhere.length > 0 && (
              <div className="mt-2 text-ds-t3">
                {elsewhere.map((c, i) => (
                  <span key={c.key}>{i > 0 ? " · " : ""}<button type="button" className="text-ds-gold hover:underline" onClick={() => pickFilter(c.key)}>{c.label} ({counts?.[c.key]})</button></span>
                ))}{" "}
                {elsewhere.length === 1 ? "has" : "have"} payouts waiting for you{scoped ? " in this campaign" : ""}.
              </div>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <>
            <div aria-hidden className="hidden md:grid grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_104px_minmax(0,1.5fr)] gap-x-4 px-5 py-2.5 text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 border-b border-[#132430]">
              <span>Creator &amp; page</span>
              <span>Campaign</span>
              <span className="text-right">Amount</span>
              <span>Status</span>
            </div>
            <ul>
              {rows.map((r) => (
                <PayoutRowItem key={r.id} row={r} releaseOn={releaseOn} onOpen={openAction} />
              ))}
            </ul>
          </>
        )}
      </section>

      {rows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px] text-ds-t3">
          <span>Showing {rows.length}{!scoped && viewTotal !== undefined && viewTotal > rows.length ? ` of ${viewTotal}` : ""}.</span>
          {!scoped && last?.nextCursor && (
            <button type="button" className={BTN_GHOST} disabled={loadingMore} onClick={() => void queue.setSize(queue.size + 1)}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}

      {dialog}
      {switchDialog && (
        <ActionDialog
          spec={releaseSwitchSpec(switchDialog)}
          onCancel={() => setSwitchDialog(null)}
          // No usable answer: it may have been switched, so the switch and the queue are re-read now.
          onUnconfirmed={() => {
            void sw.mutate();
            void refresh();
          }}
          onDone={(result) => {
            const to = switchDialog;
            setSwitchDialog(null);
            setErr("");
            setNotice(
              result === "off"
                ? { tone: "info", text: RELEASE_SWITCH_TEXT.pausedNotice }
                : { tone: "ok", text: to === "on" ? "Releases are switched back on. Due payouts are released on the worker's next run, each after its checks." : "Done." },
            );
            void sw.mutate();
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function PayoutRowItem({ row, releaseOn, onOpen }: { row: PayoutRow; releaseOn: boolean | undefined; onOpen: (key: PayoutActionKey, row: PayoutRow) => void }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = `payout-detail-${row.id}`;
  const now = Date.now();
  return (
    <li className="px-4 sm:px-5 py-3.5 border-t border-[#132430] first:border-t-0">
      {/* Four cells. On a phone: creator | amount, then status, then campaign. From md: four columns (explicit placement, so the DOM order stays the reading order). */}
      <div className="grid gap-x-4 gap-y-2 grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_104px_minmax(0,1.5fr)]">
        <div className="min-w-0 md:col-start-1 md:row-start-1">
          <div className="flex items-center gap-2 min-w-0">
            {row.platform && <PlatformDot platform={row.platform} />}
            <span className="text-[13.5px] font-semibold text-ds-text truncate">{row.pageName ?? "Page not on record"}</span>
          </div>
          <div className="text-[12px] text-ds-t3 truncate">
            <Link href={`/creators/${row.creatorId}`} className="text-ds-gold hover:underline">{row.creatorName ?? "Creator"}</Link>
            {row.platform ? ` · ${row.platform}` : ""}{row.format ? ` · ${row.format}` : ""}
          </div>
        </div>

        <div className="text-right md:col-start-3 md:row-start-1">
          <div className="text-[13.5px] font-semibold text-ds-text tabular-nums">{rupees(row.amountPaise)}</div>
          <div className="text-[11.5px] text-ds-t4">{row.amountReversedPaise > 0 ? `${rupees(row.amountReversedPaise)} taken back` : "to the creator"}</div>
        </div>

        <div className="col-span-2 md:col-span-1 md:col-start-4 md:row-start-1 min-w-0 text-[12px]">
          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
            <PayoutPill row={row} />
            <PausedChip row={row} />
          </div>
          <PayoutHint row={row} releaseOn={releaseOn} />
        </div>

        <div className="col-span-2 md:col-span-1 md:col-start-2 md:row-start-1 min-w-0 text-[12px]">
          <Link href={`/campaigns/${row.bookingId}`} className="block text-ds-gold hover:underline truncate">{row.bookingName ?? "Campaign"}</Link>
          <div className="text-ds-t3 truncate" title={row.lastEvent?.note ?? undefined}>{lastEventText(row.lastEvent)}{row.lastEvent ? ` · ${ago(row.lastEvent.at, now)}` : ""}</div>
          <div className="text-ds-t4">Age {ageShort(row.createdAt, now)} · created {fmtWhen(row.createdAt)}</div>
        </div>
      </div>

      <PayoutActions row={row} releaseOn={releaseOn} onOpen={onOpen} />
      <button
        type="button"
        className="mt-2.5 inline-flex items-center gap-1 text-[12px] text-ds-t2 hover:text-ds-text"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {expanded ? "Hide timeline & history" : "Show timeline & history"}
      </button>
      {expanded && <div id={detailId}><PayoutDetailView row={row} /></div>}
    </li>
  );
}
