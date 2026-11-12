"use client";
// Review a client's campaign booking from the sales portal: Approve, Ask for changes, Reject.
// The API calls the same review service as the staff portal's Campaigns page, so the rules —
// what each status allows, refunds, the publishing plan, the client's emails — are shared.
// Approve and Ask for changes need status paid_pending_review; Reject also works on
// changes_requested and approved (mirrors apps/internal/src/app/campaigns/[id]/page.tsx).
import { useState } from "react";
import { mutate as mutateGlobal } from "swr";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import type { BookingDetail } from "@/lib/sales-types";
import { Confirm, Field } from "@/components/sales-ui";

type Toast = { message: string; tone: "ok" | "err" };
type Action = "approve" | "changes" | "reject";

export function BookingReview({ b, onToast }: { b: BookingDetail; onToast: (t: Toast) => void }) {
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const reviewable = b.status === "paid_pending_review";
  const rejectable = ["paid_pending_review", "changes_requested", "approved"].includes(b.status);
  if (!reviewable && !rejectable) return null;
  const offline = !b.paidOnline;
  const noteOk = note.trim().length >= 3;
  const accounts = b.items.filter((i) => i.billed);
  const creatorCount = accounts.filter((i) => i.targetType === "creator_asset").length;
  const networkCount = accounts.length - creatorCount;
  // Where approval sends the posts: our pages to the staff posting list, creator pages to their creator.
  const afterApprove = [
    networkCount > 0 ? `${networkCount === accounts.length ? "each account goes" : `${networkCount} of our account${networkCount === 1 ? " goes" : "s go"}`} on the staff portal's posting list` : "",
    creatorCount > 0 ? `${creatorCount === 1 ? "the creator page goes to its creator" : `${creatorCount} creator pages go to their creators`}, and nothing is posted there until they accept` : "",
  ].filter(Boolean).join("; ") || "the posts go on the staff portal's posting list";

  async function run(action: Action) {
    const path = action === "approve" ? "approve" : action === "changes" ? "request-changes" : "reject";
    setBusy(action);
    try {
      const res = await apiFetch<BookingDetail & { refundError?: string | null }>(`/sales/bookings/${b.id}/${path}`, {
        method: "POST",
        body: action === "approve" ? undefined : JSON.stringify({ note: note.trim() }),
      });
      await mutateGlobal((key) => typeof key === "string" && (key.startsWith("/sales/bookings") || key.startsWith("/sales/dashboard")), undefined, { revalidate: true });
      setNote("");
      if (res.data.refundError) {
        onToast({ message: `Rejected, but the refund failed: ${res.data.refundError}. Refund it from Razorpay.`, tone: "err" });
      } else {
        onToast({
          message:
            action === "approve"
              ? `Approved. ${afterApprove.charAt(0).toUpperCase()}${afterApprove.slice(1)}.`
              : action === "changes"
                ? "Sent back to the client with your note."
                : offline
                  ? "Rejected. Nothing was charged online."
                  : "Rejected and refunded in full.",
          tone: "ok",
        });
      }
    } catch (err) {
      onToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  return (
    <section className="card p-4 text-sm mb-4">
      <h2 className="font-bold mb-1">Review</h2>
      <p className="text-ink-3 mb-3">
        {reviewable ? "Check the content above, then approve it or send it back. " : "This booking can still be rejected. "}
        {offline
          ? `No online payment was taken — collect ${b.totalPaise != null ? fmtInr(b.totalPaise) : "the amount"} from the client by hand. Rejecting charges nothing.`
          : "Rejecting refunds the client in full."}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 items-start">
        <div>
          {reviewable && (
            <button type="button" className="btn w-full" disabled={!!busy} onClick={() => setConfirm("approve")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
          )}
          <p className="text-xs text-ink-4 mt-2">Posting and post links stay in the staff portal&apos;s Campaigns page.</p>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <Field label="Note to the client" hint="Needed to ask for changes or reject — the client sees it in their email.">
            <textarea className="input min-h-[80px]" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to change, or why we can't run it" />
          </Field>
          <div className="flex flex-wrap gap-2">
            {reviewable && (
              <button type="button" className="btn btn-light" disabled={!!busy || !noteOk} onClick={() => run("changes")}>
                {busy === "changes" ? "Sending…" : "Ask for changes"}
              </button>
            )}
            <button type="button" className="btn btn-danger" disabled={!!busy || !noteOk} onClick={() => setConfirm("reject")}>
              {busy === "reject" ? "Rejecting…" : offline ? "Reject" : "Reject & refund"}
            </button>
          </div>
        </div>
      </div>
      {confirm === "approve" && (
        <Confirm
          title="Approve this booking?"
          body={
            <>
              {accounts.length} account{accounts.length === 1 ? "" : "s"} ({accounts.map((i) => i.accountName).join(", ")})
              {b.launchFrom ? <>, posting between {fmtDate(b.launchFrom)} and {fmtDate(b.launchTo)}</> : null}. {afterApprove.charAt(0).toUpperCase()}{afterApprove.slice(1)}. We email the client that it&apos;s approved.
            </>
          }
          confirmLabel="Approve"
          onConfirm={() => run("approve")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "reject" && (
        <Confirm
          title={offline || b.totalPaise == null ? `Reject this booking from ${b.client.companyName}?` : `Reject and refund ${fmtInr(b.totalPaise)} to ${b.client.companyName}?`}
          body="The client is emailed your note. This can't be undone."
          confirmLabel={offline ? "Reject" : "Reject & refund"}
          danger
          onConfirm={() => run("reject")}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
