"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { errorSentence } from "@/lib/messages";
import { LegalPage } from "@/components/site-shell";

// Meta's "data deletion instructions URL" for the creator connect app. When someone removes the
// app and asks Meta to delete their data, Meta calls POST /v1/meta/data-deletion and gives the
// person a link here with ?code=<confirmation code>; this page shows that request's status from
// GET /v1/public/meta-data-deletion/:code (code, status and dates — nothing else).

type DeletionStatus = { code: string; status: string; receivedAt: string; completedAt: string | null };

// What each status means, exactly as POST /v1/meta/data-deletion leaves it:
// - completed: the creator connection and its pages (tokens, page details, insights) were deleted
//   at once. The creator account itself (name, email) is not Facebook data and stays.
// - received: nothing was deleted automatically — a person on our team handles it.
// - no_data: nothing of this Facebook account is held by Digital Sukoon Creators. Say nothing about
//   other products that connect through the same Facebook app: we can't speak for them.
const STATUS_TEXT: Record<string, { title: string; body: string }> = {
  received: {
    title: "Received.",
    body: "A member of our team is handling your request. We complete deletion requests within 30 days.",
  },
  completed: {
    title: "Completed.",
    body:
      "We have deleted your Facebook access tokens and the page details and insights we held from your Facebook connection. " +
      "If you also have a Digital Sukoon Creators account, it stays open until you close it — see below.",
  },
  no_data: {
    title: "Nothing to delete.",
    body:
      "Digital Sukoon Creators holds no data from your Facebook account, so there was nothing for us to delete. " +
      "If you used another service that connects through the same Facebook app, contact that service as well.",
  },
};

const CODE_RE = /^[A-Za-z0-9_-]{4,32}$/;

function RequestStatus({ code }: { code: string }) {
  const [state, setState] = useState<{ loading: boolean; data?: DeletionStatus; error?: string }>({ loading: true });
  useEffect(() => {
    if (!CODE_RE.test(code)) { setState({ loading: false, error: "That confirmation code doesn't look right. Check the link from Facebook." }); return; }
    let alive = true;
    apiFetch<DeletionStatus>(`/public/meta-data-deletion/${encodeURIComponent(code)}`)
      .then((r) => { if (alive) setState({ loading: false, data: r.data }); })
      .catch((err) => {
        if (!alive) return;
        setState({
          loading: false,
          error: err instanceof ApiError && err.status === 404
            ? "We couldn't find a request with that confirmation code. Check the link from Facebook, or email us."
            : errorSentence(err),
        });
      });
    return () => { alive = false; };
  }, [code]);

  return (
    <div className="card p-5 sm:p-6 mb-8" aria-live="polite">
      <p className="kicker">Your request</p>
      <p className="mt-2 text-sm text-ink-3">Confirmation code <span className="font-mono text-white break-all">{code}</span></p>
      {state.loading && <p className="mt-3 flex items-center gap-2 text-sm text-ink-3"><span className="spinner" aria-hidden /> Checking…</p>}
      {state.error && <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p>}
      {state.data && (
        <>
          <h2 className="mt-3 text-xl font-extrabold text-white">{STATUS_TEXT[state.data.status]?.title ?? state.data.status}</h2>
          <p className="mt-1 text-sm text-ink-3">{STATUS_TEXT[state.data.status]?.body}</p>
          <p className="mt-3 text-xs text-ink-4">
            Received {fmtDate(state.data.receivedAt)}{state.data.completedAt ? ` · completed ${fmtDate(state.data.completedAt)}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function DeletionContent() {
  const code = useSearchParams().get("code");
  return (
    <>
      {code && <RequestStatus code={code} />}
      <Instructions />
    </>
  );
}

function Instructions() {
  return (
    <>
      <p>
        You can ask us to delete the data we hold about you at any time. Here are the ways to do it — use whichever is easiest.
      </p>

      <h2>1. Remove our app from Facebook</h2>
      <p>
        In Facebook, open <strong>Settings &amp; privacy → Settings → Business integrations</strong> (on some accounts: Apps and websites),
        find <strong>“Post Automation 2”</strong> and remove it. When Facebook tells us, we stop reading your pages and delete our copy of
        your access tokens straight away; the page details and insights we collected are deleted within 30 days.
      </p>
      <p>
        If you also choose to have Facebook ask us to delete your data, Meta sends us a deletion request and we delete your access
        tokens, page details and insights at once. Facebook gives you a confirmation code; open the link it shows to check the status
        here.
      </p>

      <h2>2. Disconnect Facebook in the portal</h2>
      <p>
        <Link href="/login?next=%2Fconnect">Sign in</Link> and choose <strong>Pages → Disconnect</strong>. We delete our copy of your access
        tokens at once and stop reading your pages; the page details and insights we collected are deleted within 30 days. Your creator
        account stays open, and you can connect again later.
      </p>

      <h2>3. Close your creator account</h2>
      <p>
        If you have a Digital Sukoon Creators account, <Link href="/login?next=%2Fsettings">sign in</Link> and choose{" "}
        <strong>Settings → Close my account</strong>. That disconnects Facebook, deletes our copy of your access tokens at once and takes
        your pages off Digital Sukoon Creators. The page details and insights we collected are deleted within 30 days.
      </p>
      <p>
        We keep a basic record of a closed account — your name, email address, country and the history of our reviews — so nobody can
        reuse your email address to sign up as you. Email us if you want that record erased too.
      </p>

      <h2>4. Email us</h2>
      <p>
        Write to <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a> from the email address on your account and
        ask us to delete your data, including the record of a closed account. We&apos;ll confirm when it&apos;s done, within 30 days.
      </p>

      <h2>What we keep</h2>
      <p>
        If bookings and payments start, records of them will be kept for as long as tax and accounting law requires, then deleted.
        Everything else is deleted as described above. See the <Link href="/privacy">privacy policy</Link> for the full list of what we store.
      </p>
    </>
  );
}

export default function DataDeletionPage() {
  return (
    <LegalPage kicker="Your data" title="Data deletion" updated="17 October 2026">
      <Suspense fallback={<Instructions />}>
        <DeletionContent />
      </Suspense>
    </LegalPage>
  );
}
