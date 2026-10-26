"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, Check } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, hasSession } from "@/lib/api";
import type { StaffSession } from "@/lib/types";
import { errorSentence } from "@/lib/messages";
import { safeNext } from "@/lib/safe-next";
import { useHydrated } from "@/lib/use-hydrated";
import { AuthFallback, AuthField, AuthShell } from "@/components/auth/shared";

// Staff sign-in: POST /v1/auth/login through useAuth().login (the same account as the staff
// portal). Password resets live on the staff portal, so the link points there.

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function LoginForm() {
  const { login, adoptSession } = useAuth();
  const router = useRouter();
  useSearchParams(); // keep ?next= reactive under the Suspense boundary
  const hydrated = useHydrated();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success">("idle");

  useEffect(() => {
    // Arriving from the staff or HR portal with a one-time handoff code (#handoff=): exchange it
    // for a sales session and go straight in. A used or expired code falls back to the form.
    const code = new URLSearchParams(window.location.hash.slice(1)).get("handoff") ?? new URLSearchParams(window.location.search).get("handoff");
    if (code) {
      window.history.replaceState(null, "", "/login");
      setState("loading");
      apiFetch<StaffSession>("/auth/handoff/exchange", { method: "POST", body: JSON.stringify({ code }) })
        .then((res) => { setState("success"); adoptSession(res.data); })
        .catch((err) => { setError(errorSentence(err, "That sign-in link has expired — sign in below.")); setState("idle"); });
      return;
    }
    if (hasSession()) router.replace(safeNext() ?? "/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state !== "idle") return;
    setError("");
    if (!emailOk(email)) { setError("Please enter a valid email."); return; }
    if (!password) { setError("Password is required."); return; }
    setState("loading");
    try {
      await login(email.trim(), password);
      setState("success");
    } catch (err) {
      setError(errorSentence(err, "That email and password don't match."));
      setState("idle");
    }
  }

  return (
    <AuthShell
      kicker="Sales portal · Sign in"
      title={<>Inventory, quotes,<br /><em>invoices.</em></>}
      lines={[
        <>Every channel on every platform with live numbers, quotes that become orders, GST invoices with payments tracked to the rupee.</>,
        <>Sign in with your staff portal account. Access needs the Sales or Admin role.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>Sign in.</h2>
          <p>Welcome back to Digital Sukoon Sales.</p>
        </div>
        <form onSubmit={handleSubmit} noValidate className="auth-form">
          <AuthField id="lemail" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@digitalsukoon.com"
            value={email} onChange={(v) => { setEmail(v); if (error) setError(""); }} error={null} />
          <AuthField id="lpw" label="Password" type="password" autoComplete="current-password" placeholder="Your password"
            value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} error={null}
            showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
          <div className="auth-row">
            <span className="auth-fine">Same account as the staff portal.</span>
            <a className="auth-link" href="https://portal.digitalsukoon.com/login" target="_blank" rel="noreferrer">Forgot password?</a>
          </div>
          {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
          <button type="submit" disabled={state !== "idle" || !hydrated} className="auth-btn" aria-live="polite">
            {state === "idle" && (<><span>Sign in</span><ArrowRight size={17} /></>)}
            {state === "loading" && (<><span className="auth-spinner" aria-hidden /><span>Signing you in…</span></>)}
            {state === "success" && (<><Check size={18} strokeWidth={3} /><span>Opening…</span></>)}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in a static export; the fallback is real content.
  return (
    <Suspense fallback={<AuthFallback title="Sign in." />}>
      <LoginForm />
    </Suspense>
  );
}
