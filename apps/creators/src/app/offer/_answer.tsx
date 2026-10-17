"use client";
import { useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { offerErrorChangesState, offerErrorSentence } from "@/lib/messages";
import { fmtInr } from "@/lib/format";
import { offerPath, platformLabel, type OfferDetail } from "@/lib/offers";
import { Banner, Modal } from "@/components/ui";
import { windowText } from "@/components/offer-time";

// Accept or decline an open offer. Both go through a confirm dialog that says what the answer means, and both send ONE
// request; the API answers with the offer as it now stands, which replaces what the page shows.
//
// What the dialogs may say: only what the offer itself says. Declining sends the booking back to the brand and is
// refunded to them, so nothing is owed to the creator or by them (the plan's wording). No timing, no fee and no claim
// about when anything is paid appears here: the one money statement is the exact amount in the offer.

export type Answered = "accepted" | "declined";

interface Props {
  offer: OfferDetail;
  /** The API answered: the new state of the offer. */
  onAnswered: (next: OfferDetail, answer: Answered) => void;
  /** The offer is not in the state the page showed (expired a moment ago, withdrawn…): re-read it. */
  onStale: () => void;
}

export function AnswerCard({ offer, onAnswered, onStale }: Props) {
  const [modal, setModal] = useState<"accept" | "decline" | null>(null);
  const [cardError, setCardError] = useState("");
  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-4" aria-labelledby="answer-title">
      <div>
        <h2 id="answer-title" className="text-xl font-extrabold tracking-[-0.03em]">Your answer</h2>
        <p className="mt-2 text-sm text-ink-3 leading-relaxed max-w-2xl">
          If you accept, you post this yourself on {offer.pageName} during the posting dates, exactly as given and with the
          paid-partnership label on. If you&apos;d rather not, decline: nothing is posted and nothing is owed.
        </p>
      </div>
      {cardError && <Banner tone="warn" role="alert">{cardError}</Banner>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn" onClick={() => { setCardError(""); setModal("accept"); }}>Accept offer</button>
        <button type="button" className="btn btn-ghost" onClick={() => { setCardError(""); setModal("decline"); }}>Decline</button>
      </div>
      {modal === "accept" && (
        <AcceptModal
          offer={offer}
          onClose={() => setModal(null)}
          onAnswered={(n) => { setModal(null); onAnswered(n, "accepted"); }}
          onStale={(text) => { setModal(null); setCardError(text); onStale(); }}
        />
      )}
      {modal === "decline" && (
        <DeclineModal
          offer={offer}
          onClose={() => setModal(null)}
          onAnswered={(n) => { setModal(null); onAnswered(n, "declined"); }}
          onStale={(text) => { setModal(null); setCardError(text); onStale(); }}
        />
      )}
    </section>
  );
}

interface ModalProps {
  offer: OfferDetail;
  onClose: () => void;
  onAnswered: (next: OfferDetail) => void;
  onStale: (sentence: string) => void;
}

function AcceptModal({ offer, onClose, onAnswered, onStale }: ModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Set synchronously: two quick taps can both pass a `busy` check that React has not flushed yet.
  const sending = useRef(false);
  const dates = windowText(offer.window);

  async function accept() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<OfferDetail>(`${offerPath(offer.id)}/accept`, { method: "POST" });
      onAnswered(r.data);
    } catch (err) {
      const text = offerErrorSentence(err);
      if (offerErrorChangesState(err)) onStale(text);
      else {
        setError(text);
        setBusy(false);
        sending.current = false;
      }
    }
  }

  return (
    <Modal title="Accept this offer?" onClose={busy ? () => {} : onClose}>
      <ul className="flex flex-col gap-2 text-sm text-ink-3 leading-relaxed list-disc pl-5">
        <li>
          You post it yourself on <span className="text-white">{offer.pageName}</span> ({platformLabel(offer.platform)}){dates ? <>, between <span className="text-white">{dates}</span> (IST)</> : null}, exactly as given.
        </li>
        <li>You switch on the paid-partnership label before you publish.</li>
        <li>You paste the link of your post here, and our team checks it.</li>
        <li>
          The offer is <span className="text-white font-bold">{fmtInr(offer.payout?.paise)}</span>, after any tax deducted at source.
        </li>
      </ul>
      {error && <Banner tone="danger" role="alert">{error}</Banner>}
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Not yet</button>
        <button type="button" className="btn btn-sm" onClick={accept} disabled={busy}>
          {busy ? <><span className="spinner" aria-hidden /> Accepting…</> : "Accept offer"}
        </button>
      </div>
    </Modal>
  );
}

function DeclineModal({ offer, onClose, onAnswered, onStale }: ModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const sending = useRef(false);

  async function decline() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const why = reason.trim();
      const r = await apiFetch<OfferDetail>(`${offerPath(offer.id)}/decline`, {
        method: "POST",
        body: JSON.stringify(why ? { reason: why } : {}),
      });
      onAnswered(r.data);
    } catch (err) {
      const text = offerErrorSentence(err);
      if (offerErrorChangesState(err)) onStale(text);
      else {
        setError(text);
        setBusy(false);
        sending.current = false;
      }
    }
  }

  return (
    <Modal title="Decline this offer?" onClose={busy ? () => {} : onClose}>
      <p className="text-sm text-ink-3 leading-relaxed">
        If you decline, this booking goes back to the brand and is refunded to them. Nothing is owed to you or by you, and nothing is posted on {offer.pageName}.
      </p>
      <div className="field">
        <label htmlFor="decline-reason" className="field-label">
          Reason<span className="normal-case tracking-normal text-ink-4"> (optional)</span>
        </label>
        <textarea
          id="decline-reason"
          className="input text-base min-h-[96px] py-2"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby="decline-reason-hint"
        />
        <span id="decline-reason-hint" className="text-xs text-ink-4 leading-relaxed">Our team reads it. You don&apos;t have to give one.</span>
      </div>
      {error && <Banner tone="danger" role="alert">{error}</Banner>}
      <div className="flex flex-wrap gap-2 justify-end">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Keep the offer</button>
        <button type="button" className="btn btn-danger btn-sm" onClick={decline} disabled={busy}>
          {busy ? <><span className="spinner" aria-hidden /> Declining…</> : "Decline offer"}
        </button>
      </div>
    </Modal>
  );
}
