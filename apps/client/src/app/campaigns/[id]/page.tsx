"use client";
import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { mutate as revalidate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { CAMPAIGN_TYPE_LABELS, FORMAT_LABELS, type CampaignFormat } from "@dashmani/shared/src/validators/campaign";
import { todayIST } from "@dashmani/shared/src/utils/date";
import { useAuth } from "@/lib/auth";
import { compact, mutateJson, previewUrl, renderFailed, renderPending, renderPendingCounts, rupees, useCampaign, useResults, PLATFORM_LABEL, type Campaign, type CampaignListRow } from "@/lib/campaign";
import { AccountsStep, CreativeStep, InfoForm } from "../_steps";
import { ItemTextRow } from "../_item-text";
import { StepNav, STEPS, type Step } from "../_step-nav";
import { Card, CampaignStatus, ErrorBanner, ItemStatus, PlatformDot, fmtDate, fmtDateTime } from "../_ui";
import { InvoiceList } from "@/components/invoice-list";
import { useClientInvoices } from "@/lib/hooks/use-invoices";

const PRE_PAY = ["draft", "awaiting_payment"];
/** Statuses where an offline campaign's amount is still to be settled with our team. */
const SETTLING = ["paid_pending_review", "approved", "publishing", "completed", "partially_published"];

function firstIncomplete(c: Campaign): Step {
  if (!c.format || c.media.length === 0) return "creative";
  if (c.items.length === 0) return "accounts";
  return "pay";
}

function reachedOf(c: Campaign): Record<Step, boolean> {
  return {
    info: true,
    creative: true,
    accounts: Boolean(c.format && c.media.length),
    pay: Boolean(c.format && c.media.length && c.items.length),
  };
}

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: c, error, isLoading, mutate } = useCampaign(id);
  const [step, setStep] = useState<Step | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusStep = useRef(false);
  // Checkout state lives here, not in PayStep, so the header can hide "Cancel campaign" while a
  // payment is being confirmed or a checkout is in flight (cancel must never race money).
  const [payBusy, setPayBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Where a detour should come back to: Accounts → "change the type in Details" returns to
  // Accounts, Review → "Update dates" returns to Review. Cleared by any direct step pick.
  const returnTo = useRef<Step | null>(null);

  // The step lives in the URL (?step=), so a refresh stays put. A ?step= the campaign hasn't
  // reached yet falls back to the first unfinished step.
  useEffect(() => {
    if (c && !step) {
      const q = new URLSearchParams(window.location.search).get("step") as Step | null;
      setStep(q && STEPS.some((s) => s.id === q) && reachedOf(c)[q] ? q : firstIncomplete(c));
    }
  }, [c, step]);

  const prePayNow = !!c && PRE_PAY.includes(c.status);
  useEffect(() => {
    if (!step || !prePayNow) return;
    const want = `?step=${step}`;
    // history.replaceState (Next 14.1+ keeps the router in sync) — no RSC round-trip, no new history entry.
    if (window.location.search !== want) window.history.replaceState(null, "", `${window.location.pathname}${want}`);
  }, [step, prePayNow]);

  // After a step change, put keyboard / screen-reader focus on the new step's heading.
  useEffect(() => {
    if (!focusStep.current) return;
    focusStep.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  if (error && !c) return <><Topstrip title="Campaign" /><div className="p-6"><PageError message={error.message || "Could not load this campaign."} /></div></>;
  if (isLoading || !c) return <><Topstrip title="Campaign" /><div className="p-6 grid gap-3"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-40 w-full" /></div></>;

  const goTo = (s: Step) => {
    focusStep.current = true;
    setStep(s);
    window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  const saved = (next: Campaign, go?: Step) => {
    mutate(next, { revalidate: true });
    if (go) goTo(go);
  };

  // Take the pending detour target if there is one; a step the saved campaign no longer
  // reaches (a type change can drop every account) falls back to the first unfinished one.
  const resume = (next: Campaign, fallback: Step) => {
    const want = returnTo.current ?? fallback;
    returnTo.current = null;
    saved(next, reachedOf(next)[want] ? want : firstIncomplete(next));
  };

  const detour = (from: Step) => (to: Step, next?: Campaign) => {
    returnTo.current = from;
    if (next) mutate(next, { revalidate: true });
    goTo(to);
  };

  const cancel = async () => {
    if (!window.confirm("Cancel this campaign? You can start a new one any time.")) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      await mutateJson(`/client/campaigns/${c.id}/cancel`, "POST");
      // Mark the row in the cached list before landing on it (the list hook isn't mounted yet, so a
      // bare revalidate would do nothing), so it never shows this campaign as a draft first.
      await revalidate<CampaignListRow[]>("/client/campaigns", (rows) => rows?.map((r) => (r.id === c.id ? { ...r, status: "cancelled" } : r)), { revalidate: false }).catch(() => undefined);
      router.push("/campaigns");
    } catch (e) {
      setCancelError(e instanceof Error && e.message ? e.message : "Couldn't cancel this campaign — please try again.");
      mutate();
    } finally {
      setCancelBusy(false);
    }
  };

  const prePay = PRE_PAY.includes(c.status);
  const reached = reachedOf(c);
  const offline = c.paymentMode === "offline";
  const current = step ?? firstIncomplete(c);
  // No cancelling once money may have moved (captured, being confirmed) or while checkout runs.
  const canCancel = prePay && !c.paidAt && !confirming && !payBusy;

  return (
    <>
      <Topstrip title={c.name} sub={c.brand} right={<CampaignStatus status={c.status} />} />
      <div className="px-4 sm:px-6 py-6 max-w-[900px] mx-auto w-full flex-1 overflow-y-auto">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Link href="/campaigns" className="text-[12.5px] text-ink-3 hover:text-ink inline-flex items-center gap-1"><Icon.ChevLeft size={14} />All campaigns</Link>
          {canCancel && (
            <Button size="sm" variant="ghost" disabled={cancelBusy} onClick={cancel}>
              {cancelBusy ? "Cancelling…" : "Cancel campaign"}
            </Button>
          )}
        </div>
        {cancelError && <div className="mb-4"><ErrorBanner>{cancelError}</ErrorBanner></div>}

        {prePay ? (
          <>
            <StepNav
              current={current}
              reached={reached}
              offline={offline}
              onSelect={(s) => {
                returnTo.current = null;
                goTo(s);
              }}
              headingRef={headingRef}
            />
            {current === "info" && (
              <InfoForm
                initial={c}
                submitLabel="Save & continue"
                onSubmit={async (v) => resume(await mutateJson<Campaign>(`/client/campaigns/${c.id}/info`, "PUT", v), "creative")}
              />
            )}
            {current === "creative" && (
              <CreativeStep
                campaign={c}
                submitLabel={c.items.length ? "Save & review" : "Save & choose accounts"}
                // Accounts already picked and still all there → straight back to Review — unless the
                // client came here from Accounts (to turn the song off), which is where they return.
                onSaved={(n) => {
                  const intact = n.items.length > 0 && n.items.length === c.items.length;
                  // Lost accounts (a format or song change) are always shown, whatever the detour.
                  if (!intact) returnTo.current = null;
                  resume(n, intact ? "pay" : "accounts");
                }}
              />
            )}
            {current === "accounts" && c.format && <AccountsStep campaign={c} onSaved={(n) => resume(n, "pay")} onEdit={detour("accounts")} />}
            {current === "pay" && (
              <PayStep
                campaign={c}
                onChanged={() => mutate()}
                onEdit={detour("pay")}
                busy={payBusy}
                setBusy={setPayBusy}
                confirming={confirming}
                setConfirming={setConfirming}
              />
            )}
          </>
        ) : (
          <AfterPayment campaign={c} onChanged={(n?: Campaign) => (n ? mutate(n, { revalidate: true }) : mutate())} />
        )}
      </div>
    </>
  );
}

/**
 * The wait for our renders, explained: what is being prepared, that it takes minutes, and that
 * the client may leave. After 10 minutes on the page it says so and gives a way out.
 */
function RenderWait({ campaign: c, action }: { campaign: Campaign; action: string }) {
  const pending = renderPending(c);
  const firstSeen = useRef<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pending) {
      firstSeen.current = null;
      return;
    }
    if (firstSeen.current == null) firstSeen.current = Date.now();
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [pending]);
  if (!pending) return null;
  const { files, accounts } = renderPendingCounts(c);
  const parts = [
    files > 0 ? `${files} file${files === 1 ? "" : "s"}` : null,
    accounts > 0 ? `${accounts} account${accounts === 1 ? "" : "s"} with their own text` : null,
  ]
    .filter(Boolean)
    .join(", plus ");
  const slow = firstSeen.current != null && Date.now() - firstSeen.current >= 10 * 60_000;
  return (
    <p role="status" aria-live="polite" className="text-[13px] text-ink-2 mb-3">
      Preparing your preview: {parts || "your files"}. This usually takes a few minutes, longer when our servers are busy. Your campaign is saved — you can leave this page and come back from Campaigns; this page updates by itself. You can {action} once it&apos;s ready.
      {slow && " This is taking longer than usual. You don't need to wait here — if it still isn't ready later today, email hello@digitalsukoon.com."}
    </p>
  );
}

// ── Review & pay ────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void; on: (e: string, cb: (r: any) => void) => void };
  }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the payment window. Check your connection and try again."));
    document.body.appendChild(s);
  });
}

function PayStep({ campaign: c, onChanged, onEdit, busy, setBusy, confirming, setConfirming }: {
  campaign: Campaign;
  onChanged: () => void;
  onEdit: (s: Step) => void;
  /** Lifted to the page so the header's Cancel hides while checkout runs or a payment confirms. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  confirming: boolean;
  setConfirming: (b: boolean) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const rendering = renderPending(c);
  const failed = renderFailed(c);
  // Only a per-account variant failed: Content has no Try again for it — a re-save of that
  // account's text re-queues it (syncRenderVariants).
  const fileFailed = failedFile(c);
  const subtotal = c.items.reduce((s, i) => s + i.pricePaise, 0);
  // GST is charged on top; the server works it out exactly as the tax invoice will.
  const pricing = c.pricing ?? null;
  const total = pricing?.totalPaise ?? subtotal;
  const offline = c.paymentMode === "offline";
  // Only the campaign's own files (not per-account variants) are shown in the strip below.
  const defaultPending = (c.thumbnail ? [...c.media, c.thumbnail] : c.media).some((m) => m.renderStatus === "queued" || m.renderStatus === "rendering");
  // The window opened before the client got here (dates are IST day keys, so a string compare is exact).
  const datePassed = !!c.launchFrom && c.launchFrom < todayIST();

  // "Text per account" is folded away unless something there needs the client's eye.
  const forced = c.items.some((i) => i.renderStatus === "queued" || i.renderStatus === "failed");
  const nCustom = c.items.filter((i) => i.captionOverride != null || i.superTextOverride != null).length;
  const open = forced || (userOpen ?? nCustom > 0);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = await mutateJson<{ offline?: boolean; orderId: string; amount: number; currency: string; keyId: string; name: string }>(`/client/campaigns/${c.id}/checkout`, "POST");
      if (order.offline) {
        // No gateway: the booking is now in review. The parent re-fetches and shows the status.
        onChanged();
        return;
      }
      await loadRazorpay();
      const user = (() => {
        try {
          return JSON.parse(localStorage.getItem("clientUser") || "{}");
        } catch {
          return {};
        }
      })();
      const rz = new window.Razorpay!({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: "Digital Sukoon",
        description: order.name,
        // The stored session user is { id, name, companyName, email } (lib/auth.ts).
        prefill: { email: user.email, name: user.name },
        theme: { color: "#403cfa" },
        handler: async (r: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          setConfirming(true);
          try {
            await mutateJson(`/client/campaigns/${c.id}/payment/verify`, "POST", { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature });
          } catch {
            /* the webhook confirms the payment either way */
          }
          onChanged();
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rz.on("payment.failed", (r: any) => {
        setError(r?.error?.description || "The payment didn't go through. You weren't charged — try again.");
        setBusy(false);
      });
      rz.open();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : offline ? "The campaign couldn't be submitted." : "Payment couldn't start.");
      setBusy(false);
      // A stale tab (already submitted, cancelled, expired) re-fetches and lands on the right view.
      onChanged();
    }
  };

  if (confirming || (c.status === "awaiting_payment" && c.paidAt)) {
    return (
      <Card title="Confirming your payment…" sub="This usually takes a few seconds. You can leave this page — we'll email you.">
        <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full w-1/2 bg-indigo animate-pulse" /></div>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card
        title="Preview"
        sub={defaultPending ? "Your files are shown without the printed text until the preview is ready." : c.superText ? "This is what will be posted, with your printed text in place." : "This is what will be posted."}
        right={<Button size="sm" variant="ghost" onClick={() => onEdit("creative")}>Edit</Button>}
      >
        <RenderWait campaign={c} action={offline ? "submit it for review" : "pay"} />
        {failed && (
          <div className="mb-3">
            <ErrorBanner>
              {fileFailed ? (
                <>
                  We couldn&apos;t prepare one of your files. Go back to Content and press Try again.{" "}
                  <button type="button" className="underline font-semibold" onClick={() => onEdit("creative")}>Open Content</button>
                </>
              ) : (
                <>We couldn&apos;t prepare the files for one of your accounts. In the account list below, press Customise on the account marked “Couldn&apos;t prepare”, then press Save for this account.</>
              )}
            </ErrorBanner>
          </div>
        )}
        <PreviewStrip campaign={c} />
        <dl className="mt-4 grid gap-2 text-[13px]">
          <Row k="Campaign type" v={CAMPAIGN_TYPE_LABELS[c.campaignType] ?? c.campaignType} />
          <Row k="Format" v={FORMAT_LABELS[c.format as CampaignFormat] ?? c.format ?? "—"} />
          {c.audioIntegration && <Row k="Song" v={<span className="break-words">{c.audioTrack}</span>} />}
          <Row k="Post between" v={`${fmtDate(c.launchFrom)} – ${fmtDate(c.launchTo)}`} />
          {c.superText && <Row k="Printed text" v={<span className="whitespace-pre-line">{c.superText}</span>} />}
          {c.caption && <Row k="Caption" v={<span className="whitespace-pre-line break-words">{c.caption}</span>} />}
          {c.hashtags.length > 0 && <Row k="Hashtags" v={c.hashtags.map((h) => `#${h}`).join(" ")} />}
          {(c.userTags.length > 0 || c.collaborators.length > 0) && <Row k="Tags" v={[...c.userTags, ...c.collaborators].map((h) => `@${h}`).join(" ")} />}
        </dl>
      </Card>

      <Card title="Accounts" sub={nCustom ? "Accounts without their own text post the campaign's caption and printed text." : "Every account posts the campaign's caption and printed text."} right={<Button size="sm" variant="ghost" onClick={() => onEdit("accounts")}>Edit</Button>}>
        <ul className="divide-y divide-ink/5">
          {c.items.map((i) => (
            <li key={i.id} className="py-2.5 flex items-center gap-3 text-[13px]">
              <PlatformDot platform={i.platform} />
              <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-ink">{i.accountName}</span>{i.accountHandle && <span className="text-ink-3"> @{i.accountHandle}</span>}</span>
              <span className="text-ink-3 hidden sm:inline">{PLATFORM_LABEL[i.platform]}</span>
              <span className="text-right">
                <span className="block font-semibold tabular-nums">{rupees(i.pricePaise)}</span>
                {i.audioAddonPaise > 0 && <span className="block text-[11px] text-ink-3 tabular-nums">incl. {rupees(i.audioAddonPaise)} for the song</span>}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="item-text-list"
          disabled={forced && open}
          onClick={() => setUserOpen(!open)}
          className="mt-4 text-[13px] font-semibold text-ink-2 hover:text-ink disabled:cursor-default disabled:hover:text-ink-2"
        >
          {nCustom
            ? `${nCustom} account${nCustom === 1 ? " has its" : "s have their"} own text`
            : "Different text on some accounts? Customise per account"}
        </button>
        <ul id="item-text-list" hidden={!open} className="divide-y divide-ink/5">
          {c.items.map((i) => (
            <ItemTextRow key={i.id} campaign={c} item={i} editable onSaved={() => onChanged()} />
          ))}
        </ul>
        <div className="mt-3 pt-3 space-y-1" style={{ borderTop: "2px solid rgba(255,255,255,0.18)" }}>
          {pricing && pricing.gstPaise > 0 && (
            <>
              <div className="flex items-center justify-between text-[13px] text-ink-2"><span>Subtotal</span><span className="tabular-nums">{rupees(pricing.subtotalPaise)}</span></div>
              {pricing.taxMode === "intra" ? (
                <>
                  <div className="flex items-center justify-between text-[13px] text-ink-2"><span>CGST ({pricing.gstRateBp / 200}%)</span><span className="tabular-nums">{rupees(pricing.cgstPaise)}</span></div>
                  <div className="flex items-center justify-between text-[13px] text-ink-2"><span>SGST ({pricing.gstRateBp / 200}%)</span><span className="tabular-nums">{rupees(pricing.sgstPaise)}</span></div>
                </>
              ) : (
                <div className="flex items-center justify-between text-[13px] text-ink-2"><span>IGST ({pricing.gstRateBp / 100}%)</span><span className="tabular-nums">{rupees(pricing.igstPaise)}</span></div>
              )}
              {pricing.roundOffPaise !== 0 && <div className="flex items-center justify-between text-[12px] text-ink-3"><span>Round-off</span><span className="tabular-nums">{pricing.roundOffPaise > 0 ? "+" : "−"}{rupees(Math.abs(pricing.roundOffPaise))}</span></div>}
            </>
          )}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[13px] font-semibold text-ink-2">{pricing && pricing.gstPaise > 0 ? "Total incl. GST" : "Total"}</span>
            <span className="text-[19px] font-bold text-ink tabular-nums">{rupees(total)}</span>
          </div>
        </div>
        <p className="text-[13px] text-ink-2 mt-2">
          {offline
            ? "No online payment is needed now. Submit the campaign and our team will review it (usually within a working day) and confirm the amount and payment details with you. You'll get an email with the link to every post once it's live."
            : "After payment our team reviews your campaign (usually within a working day). If we can't run it, you get a full refund. You'll get an email with the link to every post once it's live."}
        </p>
      </Card>

      {datePassed && (
        <ErrorBanner>
          Your earliest posting date has passed — update the dates before submitting.{" "}
          <button type="button" className="underline font-semibold" onClick={() => onEdit("info")}>Update dates</button>
        </ErrorBanner>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex justify-end">
        <Button variant="ink" onClick={pay} disabled={busy || rendering || failed || datePassed} aria-live="polite">
          {busy ? (offline ? "Submitting…" : "Opening payment…") : rendering ? "Preparing preview…" : offline ? `Submit for review · ${rupees(total)}` : `Pay ${rupees(total)}`}
        </Button>
      </div>
    </div>
  );
}

/** A failed render of the campaign's own file (or thumbnail) — the kind Content can retry. */
function failedFile(c: Campaign): boolean {
  return (c.thumbnail ? [...c.media, c.thumbnail] : c.media).some((m) => m.renderStatus === "failed");
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-ink min-w-0">{v}</dd>
    </div>
  );
}

function PreviewStrip({ campaign: c }: { campaign: Campaign }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const files = c.thumbnail ? [...c.media, c.thumbnail] : c.media;
  const key = files.map((m) => `${m.id}:${m.renderStatus}`).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(files.map(async (m) => [m.id, await previewUrl(m.id).catch(() => "")] as const)).then((pairs) => {
      if (live) setUrls(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {files.map((m) => (
        <div key={m.id} className="relative shrink-0 w-[180px] aspect-[9/16] rounded-xl bg-surface overflow-hidden grid place-items-center">
          {m.role === "thumbnail" && <span className="absolute top-2 left-2 z-10 bg-black/70 text-white text-[11px] font-bold px-2 py-0.5">Thumbnail</span>}
          {urls[m.id] ? (
            m.kind === "video" ? (
              <video src={urls[m.id]} controls playsInline preload="metadata" className="w-full h-full object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urls[m.id]} alt={m.originalName} className="w-full h-full object-contain" />
            )
          ) : (
            <span className="text-white/60 text-[12px]">{m.renderStatus === "done" ? "Loading…" : m.renderStatus === "failed" ? "" : "Preparing…"}</span>
          )}
          {/* Until the render is done the strip shows the raw upload — say so, so nobody reads it as final. */}
          {urls[m.id] && (m.renderStatus === "queued" || m.renderStatus === "rendering") && (
            <span className="absolute bottom-2 left-2 right-2 z-10 rounded-full bg-black/70 text-white text-[11px] font-semibold px-2.5 py-1">
              Preparing preview…{c.superText ? " — your text isn't on this yet" : ""}
            </span>
          )}
          {m.renderStatus === "failed" && (
            <span className="absolute bottom-2 left-2 right-2 z-10 rounded-full bg-black/80 text-danger border border-danger/60 text-[11px] font-semibold px-2.5 py-1">
              Couldn&apos;t prepare — press Try again in Content
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── After payment: status, changes, results ─────────────────────────────────────

function AfterPayment({ campaign: c, onChanged }: { campaign: Campaign; onChanged: (saved?: Campaign) => void }) {
  const live = ["approved", "publishing", "completed", "partially_published"].includes(c.status);
  const { data: results } = useResults(c.id, live);
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // paidAt is set only by an online payment; a booking submitted without one must never be
  // told it paid or that a refund is on its way.
  const paidOnline = Boolean(c.paidAt);
  const hasWindow = Boolean(c.launchFrom && c.launchTo);
  const windowText = hasWindow ? `${fmtDate(c.launchFrom)} – ${fmtDate(c.launchTo)}` : null;
  const message: Record<string, string> = {
    paid_pending_review: paidOnline
      ? "Payment received. Our team is reviewing your campaign — usually within one working day."
      : "Submitted. Our team is reviewing your campaign — usually within one working day — and will confirm the amount and payment details with you.",
    approved: hasWindow
      ? `Approved. Your posts will go live between ${fmtDate(c.launchFrom)} and ${fmtDate(c.launchTo)}; you'll get an email with each link as it goes live.`
      : "Approved. Your posts are scheduled; you'll get an email with each link as it goes live.",
    publishing: "Your posts are going live. Links appear below as each one is posted.",
    completed: "Every post is live. The links are below and in your email.",
    partially_published: paidOnline
      ? "Your campaign is done. Some posts couldn't go live — those were refunded."
      : "Your campaign is done. Some posts couldn't go live — those won't be charged.",
    rejected: paidOnline
      ? "We couldn't run this campaign. A full refund is on its way (5–7 working days)."
      : "We couldn't run this campaign. Nothing has been charged for it.",
    refunded: paidOnline ? "This campaign was refunded in full." : "This campaign was closed. Nothing has been charged for it.",
    cancelled: "This campaign was cancelled.",
    expired: "This campaign wasn't completed in time and has expired. Start a new one any time.",
  };
  const showWindow = hasWindow && ["paid_pending_review", "approved", "publishing"].includes(c.status);
  // In "changes requested" the dates can't be edited here; a window that has closed goes to our team.
  const windowPassed = !!c.launchTo && c.launchTo < todayIST();

  return (
    <div className="grid grid-cols-1 gap-4">
      {c.status === "changes_requested" ? (
        <Card title="A change is needed" sub={paidOnline ? "Your payment is safe. Update your video, image or text and send it back for review." : "Update your video, image or text and send it back for review."}>
          <blockquote className="rounded-xl bg-attention-bg text-ink px-4 py-3 text-[13.5px] whitespace-pre-line">{c.reviewNote}</blockquote>
          {windowText && <p className="text-[12.5px] text-ink-3 mt-3">Go-live window: {windowText}</p>}
          {windowPassed && (
            <p className="text-[13px] text-attention mt-2">
              Your posting window has passed — reply to the review email or write to{" "}
              <a href="mailto:hello@digitalsukoon.com" className="underline font-semibold">hello@digitalsukoon.com</a> and our team will agree new dates with you.
            </p>
          )}
          {!editing && <div className="mt-3"><Button variant="ink" onClick={() => setEditing(true)}>Update your campaign</Button></div>}
        </Card>
      ) : (
        <Card>
          <p className="text-[14px] text-ink">{message[c.status] ?? ""}</p>
          {c.status === "paid_pending_review" && (
            <p className="text-[13px] text-ink-2 mt-2">
              We&apos;re sending a confirmation to {user?.email ?? "your email"} — check your inbox (and spam). Our team replies from that thread.
            </p>
          )}
          {showWindow && <p className="text-[12.5px] text-ink-3 mt-2">Go-live window: {windowText}</p>}
          {c.reviewNote && ["rejected", "refunded"].includes(c.status) && (
            <blockquote className="mt-3 rounded-xl bg-muted px-4 py-3 text-[13px] whitespace-pre-line">{c.reviewNote}</blockquote>
          )}
          {/* Offline, the total is only news while there is still something to settle — never under
              "Nothing has been charged" (rejected), a cancelled or an expired campaign. */}
          {c.totalPaise != null && (paidOnline || SETTLING.includes(c.status)) && (
            <p className="text-[12.5px] text-ink-3 mt-2">
              {paidOnline
                ? `Paid ${rupees(c.totalPaise)} incl. GST on ${fmtDateTime(c.paidAt as string)}`
                : c.status === "partially_published"
                  ? `Campaign total before the posts that couldn't be made: ${rupees(c.totalPaise)} — our team will confirm the final amount with you`
                  : `Campaign total ${rupees(c.totalPaise)} incl. GST — our team will confirm payment with you`}
            </p>
          )}
        </Card>
      )}

      {c.status === "changes_requested" && editing && (
        <>
          {/* The saved campaign goes straight into the cache, so the step never treats the file
              it just saved as "not saved yet" (which would let a × or a Replace delete it). */}
          <CreativeStep campaign={c} submitLabel="Save changes" onSaved={(n) => onChanged(n)} />
          <Card title="Text per account" sub="Give any account its own caption or printed text.">
            <ul className="divide-y divide-ink/5">
              {c.items.map((i) => (
                <ItemTextRow key={i.id} campaign={c} item={i} editable onSaved={() => onChanged()} />
              ))}
            </ul>
          </Card>
          <RenderWait campaign={c} action="send it for review" />
          {renderFailed(c) && (
            <ErrorBanner>
              {failedFile(c)
                ? "We couldn't prepare one of your files. Press Try again in the content section above, then send it for review."
                : "We couldn't prepare the files for one of your accounts. Open it under Text per account above and press Save for this account again, then send it for review."}
            </ErrorBanner>
          )}
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div className="flex justify-end">
            <Button
              variant="ink"
              aria-live="polite"
              disabled={busy || renderPending(c) || renderFailed(c)}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await mutateJson(`/client/campaigns/${c.id}/submit-changes`, "POST");
                  setEditing(false);
                  onChanged();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't send it for review. Please try again.");
                  onChanged();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Sending…" : "Send for review"}
            </Button>
          </div>
        </>
      )}

      <Card title="Your posts" sub={live ? "Each post with its link once it's live. Views and likes appear after our next sync." : undefined}>
        <ul className="divide-y divide-ink/5">
          {(results?.items ?? c.items.map((i) => ({ ...i, metrics: null }))).map((i) => (
            <li key={i.id} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <PlatformDot platform={i.platform} />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-ink truncate">{i.accountName}{i.accountHandle && <span className="text-ink-3 font-normal"> @{i.accountHandle}</span>}</div>
                  <div className="text-[12px] text-ink-3">
                    {PLATFORM_LABEL[i.platform]} · {FORMAT_LABELS[i.format as CampaignFormat] ?? i.format}
                    {i.postedAt ? ` · posted ${fmtDateTime(i.postedAt)}` : ""}
                    {!i.postedAt && "scheduledFor" in i && i.scheduledFor && new Date(i.scheduledFor) > new Date() ? ` · posts ${fmtDateTime(i.scheduledFor)}` : ""}
                  </div>
                </div>
              </div>
              {i.permalink && (
                <div className="text-[12px] text-ink-2 tabular-nums flex gap-3 shrink-0">
                  {i.metrics ? (
                    <>
                      <span>{compact(i.metrics.views)} views</span>
                      <span>{compact(i.metrics.likes)} likes</span>
                      <span>{compact(i.metrics.comments)} comments</span>
                    </>
                  ) : (
                    <span className="text-ink-3">Collecting stats…</span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 shrink-0">
                <ItemStatus status={i.status} paidOnline={paidOnline} />
                {i.permalink && (
                  <a href={i.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 h-8 px-3 rounded-xl border-2 border-ink text-[12.5px] font-semibold text-ink btn-3d bg-surface">
                    View post <Icon.External size={12} />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <BookingInvoices bookingId={c.id} />
    </div>
  );
}

/** This campaign's invoice(s), once one is issued (it is also emailed when a payment is received). */
function BookingInvoices({ bookingId }: { bookingId: string }) {
  const { data } = useClientInvoices(bookingId);
  if (!data?.length) return null;
  return (
    <Card title={data.length === 1 ? "Invoice" : "Invoices"} sub="Download a PDF any time — every invoice is also under Invoices.">
      <InvoiceList invoices={data} />
    </Card>
  );
}
