"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch, ApiError, hasSession } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { AuthFallback, AuthShell } from "@/components/auth/shared";

// /verify-email?token=… from the welcome email → POST /v1/creator/auth/verify-email (idempotent,
// so opening the link twice is fine). Works signed in or not; the dashboard re-reads the status.

type State = "working" | "ok" | "invalid" | "error" | "missing";

function Verify() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>(token ? "working" : "missing");
  const [message, setMessage] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    setSignedIn(hasSession());
    if (!token || sent.current) return;
    sent.current = true; // React strict mode runs effects twice in dev; one request is enough
    apiFetch("/creator/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setState("ok"))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "INVALID_TOKEN" || err.code === "VALIDATION_ERROR")) setState("invalid");
        else { setMessage(errorSentence(err)); setState("error"); }
      });
  }, [token]);

  const next = signedIn ? { href: "/dashboard", label: "Go to your account" } : { href: "/login?next=%2Fdashboard", label: "Sign in" };

  return (
    <AuthShell
      kicker="Creator portal · Email"
      title={<>Confirm<br /><em>your email.</em></>}
      lines={[<>We confirm every creator&apos;s email so booking requests and payments reach the right person.</>]}
    >
      <div className="auth-form-inner" aria-live="polite">
        {state === "working" && (
          <div className="auth-form-head"><h2>Checking your link…</h2><p>One moment.</p></div>
        )}
        {state === "ok" && (
          <>
            <div className="auth-form-head"><h2>Email confirmed.</h2><p>Thanks — your email address is verified. Next, connect your pages.</p></div>
            <Link href={next.href} className="auth-btn">{next.label} <ArrowRight size={17} /></Link>
          </>
        )}
        {state === "invalid" && (
          <>
            <div className="auth-form-head"><h2>This link has expired.</h2><p>Confirmation links work for 7 days. Sign in and use “Send a new link” on your overview page.</p></div>
            <Link href={next.href} className="auth-btn">{next.label} <ArrowRight size={17} /></Link>
          </>
        )}
        {state === "missing" && (
          <>
            <div className="auth-form-head"><h2>Missing confirmation code.</h2><p>Open the link from the email again — it ends with a long code.</p></div>
            <Link href={next.href} className="auth-btn">{next.label} <ArrowRight size={17} /></Link>
          </>
        )}
        {state === "error" && (
          <>
            <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{message}</span></div>
            <button type="button" className="auth-btn" onClick={() => window.location.reload()}>Try again</button>
          </>
        )}
      </div>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<AuthFallback title="Checking your link…" />}>
      <Verify />
    </Suspense>
  );
}
