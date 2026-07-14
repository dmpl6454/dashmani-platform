"use client";

import { useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// "Get job alerts" nav pill + pop-up modal. Talent-community signup: leave an email
// to hear about new roles. Lives in the shared nav so it's reachable from every page.
//
// FRONTEND ONLY for now — the submit is a stub and does NOT persist anywhere yet.
// Wiring: replace the simulated request with a POST to a future `/v1/job-alerts`
// endpoint (needs a JobAlertSubscriber table in packages/db).
export default function JobAlerts() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();

  // Greet visitors: auto-open shortly after landing on the homepage — but only
  // once per browser session, so it doesn't nag on every refresh or navigation,
  // and never on a shared role link (where the visitor came to apply).
  //
  // The "seen" flag is written when the pop-up actually opens (inside the timer),
  // NOT when the effect first runs — otherwise React StrictMode's dev double-invoke
  // (setup → cleanup → setup) would set the flag on the first pass and make the
  // second pass bail, so it would never open.
  useEffect(() => {
    if (pathname !== "/") return;
    try {
      if (sessionStorage.getItem("ds-alerts-autoopened")) return;
    } catch {
      return; // sessionStorage unavailable (private mode) — skip auto-open.
    }
    const t = window.setTimeout(() => {
      try {
        if (sessionStorage.getItem("ds-alerts-autoopened")) return;
        sessionStorage.setItem("ds-alerts-autoopened", "1");
      } catch {
        return;
      }
      setOpen(true);
    }, 500);
    return () => window.clearTimeout(t);
  }, [pathname]);

  // While the pop-up is open: focus the field, lock body scroll, close on Escape.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => emailRef.current?.focus(), 60);
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.body.style.overflow = "";
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.trim()) {
      setError("Please enter your email so we can reach you.");
      return;
    }
    setSubmitting(true);
    try {
      // TODO(backend): POST { email } to /v1/job-alerts once the endpoint and
      // JobAlertSubscriber table exist. Until then this is a UI-only stub.
      await new Promise((resolve) => setTimeout(resolve, 400));
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="ds-alerts-pill"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a1.9 1.9 0 0 1-3.4 0" />
        </svg>
        <span className="label">Get job alerts</span>
      </button>

      {open && (
        <div className="ds-alerts-modal-root" role="dialog" aria-modal="true" aria-label="Get job alerts">
          <div className="ds-alerts-backdrop" onClick={() => setOpen(false)} />
          <div className="ds-alerts">
            <button type="button" className="ds-alerts-close" onClick={() => setOpen(false)} aria-label="Close">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 4 12 12M12 4 4 12" /></svg>
            </button>

            {done ? (
              <div className="ds-alerts-success" aria-live="polite">
                <span className="ck" aria-hidden="true">✓</span>
                <h3>You&apos;re on the list</h3>
                <p>We&apos;ll email you the moment a matching role opens. No spam, just openings.</p>
              </div>
            ) : (
              <>
                <span className="ds-mono eyebrow">Stay in the loop</span>
                <h3>Get job alerts</h3>
                <form onSubmit={handleSubmit} noValidate>
                  <input
                    ref={emailRef}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    aria-label="Email address"
                  />
                  <button type="submit" className="ds-btn primary" disabled={submitting}>
                    {submitting ? "Adding…" : "Notify me"}
                  </button>
                </form>
                {error && <p className="ds-alerts-error" role="alert">{error}</p>}
                <p className="ds-alerts-fine">No spam — unsubscribe anytime.</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
