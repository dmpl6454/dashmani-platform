"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { CAMPAIGN_TYPE_LABELS, FORMAT_LABELS, type CampaignFormat } from "@dashmani/shared/src/validators/campaign";
import { compact, mutateJson, previewUrl, rupees, useCampaign, useResults, PLATFORM_LABEL, type Campaign } from "@/lib/campaign";
import { AccountsStep, CreativeStep, InfoForm } from "../_steps";
import { Card, CampaignStatus, ErrorBanner, ItemStatus, PlatformDot, fmtDate, fmtDateTime } from "../_ui";

type Step = "info" | "creative" | "accounts" | "pay";
const STEPS: { id: Step; label: string }[] = [
  { id: "info", label: "Details" },
  { id: "creative", label: "Creative" },
  { id: "accounts", label: "Accounts" },
  { id: "pay", label: "Review & pay" },
];
const PRE_PAY = ["draft", "awaiting_payment"];

function firstIncomplete(c: Campaign): Step {
  if (!c.format || c.media.length === 0) return "creative";
  if (c.items.length === 0) return "accounts";
  return "pay";
}

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: c, error, isLoading, mutate } = useCampaign(id);
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (c && !step) {
      const q = new URLSearchParams(window.location.search).get("step") as Step | null;
      setStep(q && STEPS.some((s) => s.id === q) ? q : firstIncomplete(c));
    }
  }, [c, step]);

  if (error && !c) return <><Topstrip title="Campaign" /><div className="p-6"><PageError message={error.message || "Could not load this campaign."} /></div></>;
  if (isLoading || !c) return <><Topstrip title="Campaign" /><div className="p-6 grid gap-3"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-40 w-full" /></div></>;

  const saved = (next: Campaign, go?: Step) => {
    mutate(next, { revalidate: true });
    if (go) {
      setStep(go);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const prePay = PRE_PAY.includes(c.status);
  const reached: Record<Step, boolean> = {
    info: true,
    creative: true,
    accounts: Boolean(c.format && c.media.length),
    pay: Boolean(c.format && c.media.length && c.items.length),
  };

  return (
    <>
      <Topstrip title={c.name} sub={c.brand} right={<CampaignStatus status={c.status} />} />
      <div className="px-4 sm:px-6 py-6 max-w-[900px] mx-auto w-full flex-1 overflow-y-auto">
        <div className="mb-4">
          <Link href="/campaigns" className="text-[12.5px] text-ink-3 hover:text-ink inline-flex items-center gap-1"><Icon.ChevLeft size={14} />All campaigns</Link>
        </div>

        {prePay ? (
          <>
            <nav aria-label="Steps" className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
              {STEPS.map((s, i) => {
                const active = step === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!reached[s.id]}
                    onClick={() => setStep(s.id)}
                    aria-current={active ? "step" : undefined}
                    className={`shrink-0 h-9 px-3.5 rounded-full text-[12.5px] font-semibold border-2 disabled:opacity-40 ${active ? "bg-ink text-white border-ink" : "border-ink/15 text-ink-2"}`}
                  >
                    {i + 1}. {s.label}
                  </button>
                );
              })}
            </nav>
            {step === "info" && (
              <InfoForm
                initial={c}
                submitLabel="Save & continue"
                onSubmit={async (v) => saved(await mutateJson<Campaign>(`/client/campaigns/${c.id}/info`, "PUT", v), "creative")}
              />
            )}
            {step === "creative" && <CreativeStep campaign={c} submitLabel="Save & choose accounts" onSaved={(n) => saved(n, "accounts")} />}
            {step === "accounts" && c.format && <AccountsStep campaign={c} onSaved={(n) => saved(n, "pay")} />}
            {step === "pay" && <PayStep campaign={c} onChanged={() => mutate()} onEdit={setStep} onCancelled={() => router.push("/campaigns")} />}
          </>
        ) : (
          <AfterPayment campaign={c} onChanged={() => mutate()} />
        )}
      </div>
    </>
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

function PayStep({ campaign: c, onChanged, onEdit, onCancelled }: { campaign: Campaign; onChanged: () => void; onEdit: (s: Step) => void; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const rendering = c.media.some((m) => m.renderStatus === "queued" || m.renderStatus === "rendering");
  const renderFailed = c.media.some((m) => m.renderStatus === "failed");
  const total = c.items.reduce((s, i) => s + i.pricePaise, 0);
  const offline = c.paymentMode === "offline";

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
        prefill: { email: user.email, name: user.contactName },
        theme: { color: "#1a1a1a" },
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
    <div className="grid gap-4">
      <Card title="Preview" sub="This is what will be posted, with your overlay text in place." right={<Button size="sm" variant="ghost" onClick={() => onEdit("creative")}>Edit</Button>}>
        {rendering && <p className="text-[13px] text-ink-2 mb-3">We're preparing your preview — this takes a minute or two for videos. You can pay once it's ready.</p>}
        {renderFailed && <ErrorBanner>We couldn't prepare one of your files. Go back to Creative and upload it again.</ErrorBanner>}
        <PreviewStrip campaign={c} />
        <dl className="mt-4 grid gap-2 text-[13px]">
          <Row k="Campaign type" v={CAMPAIGN_TYPE_LABELS[c.campaignType] ?? c.campaignType} />
          <Row k="Format" v={FORMAT_LABELS[c.format as CampaignFormat] ?? c.format ?? "—"} />
          {c.audioIntegration && <Row k="Song audio" v={<span className="break-words">{c.audioTrack}</span>} />}
          <Row k="Go live" v={`${fmtDate(c.launchFrom)} – ${fmtDate(c.launchTo)}`} />
          {c.superText && <Row k="Overlay" v={<span className="whitespace-pre-line">{c.superText}</span>} />}
          {c.caption && <Row k="Caption" v={<span className="whitespace-pre-line break-words">{c.caption}</span>} />}
          {c.hashtags.length > 0 && <Row k="Hashtags" v={c.hashtags.map((h) => `#${h}`).join(" ")} />}
          {(c.userTags.length > 0 || c.collaborators.length > 0) && <Row k="Tags" v={[...c.userTags, ...c.collaborators].map((h) => `@${h}`).join(" ")} />}
        </dl>
      </Card>

      <Card title="Accounts" right={<Button size="sm" variant="ghost" onClick={() => onEdit("accounts")}>Edit</Button>}>
        <ul className="divide-y divide-ink/5">
          {c.items.map((i) => (
            <li key={i.id} className="py-2.5 flex items-center gap-3 text-[13px]">
              <PlatformDot platform={i.platform} />
              <span className="min-w-0 flex-1 truncate"><span className="font-semibold text-ink">{i.accountName}</span>{i.accountHandle && <span className="text-ink-3"> @{i.accountHandle}</span>}</span>
              <span className="text-ink-3 hidden sm:inline">{PLATFORM_LABEL[i.platform]}</span>
              <span className="text-right">
                <span className="block font-semibold tabular-nums">{rupees(i.pricePaise)}</span>
                {i.audioAddonPaise > 0 && <span className="block text-[11px] text-ink-3 tabular-nums">incl. {rupees(i.audioAddonPaise)} audio</span>}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 pt-3 flex items-center justify-between" style={{ borderTop: "2px solid rgba(26,26,26,0.08)" }}>
          <span className="text-[13px] font-semibold text-ink-2">Total</span>
          <span className="text-[19px] font-bold text-ink tabular-nums">{rupees(total)}</span>
        </div>
        <p className="text-[12px] text-ink-3 mt-2">
          {offline
            ? "No online payment is needed now. Submit the campaign and our team will review the creative (usually within a working day) and confirm the amount and payment details with you. You'll get an email with the link to every post once it's live."
            : "After payment our team reviews the creative (usually within a working day). If we can't run it, you get a full refund. You'll get an email with the link to every post once it's live."}
        </p>
      </Card>

      {error && <ErrorBanner>{error}</ErrorBanner>}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-between">
        <Button
          variant="ghost"
          onClick={async () => {
            if (!window.confirm("Cancel this campaign? You can start a new one any time.")) return;
            await mutateJson(`/client/campaigns/${c.id}/cancel`, "POST").catch(() => undefined);
            onCancelled();
          }}
        >
          Cancel campaign
        </Button>
        <Button variant="ink" onClick={pay} disabled={busy || rendering || renderFailed} aria-live="polite">
          {busy ? (offline ? "Submitting…" : "Opening payment…") : rendering ? "Preparing preview…" : offline ? `Submit for review · ${rupees(total)}` : `Pay ${rupees(total)}`}
        </Button>
      </div>
    </div>
  );
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
  const key = c.media.map((m) => `${m.id}:${m.renderStatus}`).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(c.media.map(async (m) => [m.id, await previewUrl(m.id).catch(() => "")] as const)).then((pairs) => {
      if (live) setUrls(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="flex gap-3 overflow-x-auto pb-1">
      {c.media.map((m) => (
        <div key={m.id} className="shrink-0 w-[180px] aspect-[9/16] rounded-xl bg-ink/90 overflow-hidden grid place-items-center">
          {urls[m.id] ? (
            m.kind === "video" ? (
              <video src={urls[m.id]} controls playsInline preload="metadata" className="w-full h-full object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={urls[m.id]} alt={m.originalName} className="w-full h-full object-contain" />
            )
          ) : (
            <span className="text-white/60 text-[12px]">{m.renderStatus === "done" ? "Loading…" : "Preparing…"}</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── After payment: status, changes, results ─────────────────────────────────────

function AfterPayment({ campaign: c, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  const live = ["approved", "publishing", "completed", "partially_published"].includes(c.status);
  const { data: results } = useResults(c.id, live);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // paidAt is set only by an online payment; a booking submitted without one must never be
  // told it paid or that a refund is on its way.
  const paidOnline = Boolean(c.paidAt);
  const message: Record<string, string> = {
    paid_pending_review: paidOnline
      ? "Payment received. Our team is reviewing your creative — usually within one working day."
      : "Submitted. Our team is reviewing your creative — usually within one working day — and will confirm the amount and payment details with you.",
    approved: "Approved. Your posts are scheduled; you'll get an email with each link as it goes live.",
    publishing: "Your posts are going live. Links appear below as each one is posted.",
    completed: "Every post is live. The links are below and in your email.",
    partially_published: paidOnline
      ? "Your campaign is done. Some posts couldn't go live — those were refunded."
      : "Your campaign is done. Some posts couldn't go live — those won't be charged.",
    rejected: paidOnline
      ? "We couldn't run this campaign. A full refund is on its way (5–7 working days)."
      : "We couldn't run this campaign. Nothing has been charged for it.",
    refunded: "This campaign was refunded in full.",
    cancelled: "This campaign was cancelled.",
    expired: "This campaign wasn't paid in time and has expired. Start a new one any time.",
  };

  return (
    <div className="grid gap-4">
      {c.status === "changes_requested" ? (
        <Card title="A change is needed" sub={paidOnline ? "Your payment is safe. Update the creative and send it back for review." : "Update the creative and send it back for review."}>
          <blockquote className="rounded-xl bg-attention-bg text-ink px-4 py-3 text-[13.5px] whitespace-pre-line">{c.reviewNote}</blockquote>
          {!editing && <div className="mt-3"><Button variant="ink" onClick={() => setEditing(true)}>Update creative</Button></div>}
        </Card>
      ) : (
        <Card>
          <p className="text-[14px] text-ink">{message[c.status] ?? ""}</p>
          {c.reviewNote && ["rejected", "refunded"].includes(c.status) && (
            <blockquote className="mt-3 rounded-xl bg-muted px-4 py-3 text-[13px] whitespace-pre-line">{c.reviewNote}</blockquote>
          )}
          {c.totalPaise != null && (
            <p className="text-[12.5px] text-ink-3 mt-2">
              {paidOnline ? `Paid ${rupees(c.totalPaise)} on ${fmtDateTime(c.paidAt as string)}` : `Booking total ${rupees(c.totalPaise)} — to be settled with our team`}
            </p>
          )}
        </Card>
      )}

      {c.status === "changes_requested" && editing && (
        <>
          <CreativeStep campaign={c} submitLabel="Save changes" onSaved={() => onChanged()} />
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <div className="flex justify-end">
            <Button
              variant="ink"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await mutateJson(`/client/campaigns/${c.id}/submit-changes`, "POST");
                  setEditing(false);
                  onChanged();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Couldn't resubmit.");
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
                <ItemStatus status={i.status} />
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
    </div>
  );
}
