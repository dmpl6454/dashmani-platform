"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, Check, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, hasSession } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { nextQueryFor, safeNext } from "@/lib/safe-next";
import { useHydrated } from "@/lib/use-hydrated";
import { AuthFallback, AuthField, AuthShell, AuthTabs } from "@/components/auth/shared";
import { GoogleSignIn } from "@/components/auth/google-signin";

// Creator sign-in: POST /v1/creator/auth/login through useAuth().login (tokens under the
// creator* keys), "Continue with Google", and the forgot-password modal → POST
// /v1/creator/auth/forgot-password, whose answer is deliberately the same for every email.

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function LoginForm() {
  const { login, adoptSession } = useAuth();
  const router = useRouter();
  const nextParam = useSearchParams().get("next");
  const hydrated = useHydrated();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success">("idle");
  const [forgotOpen, setForgotOpen] = useState(false);

  // Already signed in (Back, or a refresh after signing in): go on, not back to the form.
  useEffect(() => {
    if (hasSession()) router.replace(safeNext() ?? "/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emailErr = emailBlurred && email && !emailOk(email) ? "Please enter a valid email" : null;
  const signInHref = `/login${nextQueryFor(nextParam)}`;
  const signUpHref = `/signup${nextQueryFor(nextParam)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state !== "idle") return;
    setError("");
    if (!emailOk(email)) { setEmailBlurred(true); setError("Please enter a valid email."); return; }
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
      kicker="Creator portal · Sign in"
      title={<>Your page,<br /><em>your call.</em></>}
      lines={[
        <>Connect your Facebook Page or Instagram professional account, and brands can book promotion on it.</>,
        <>You approve every booking before anything is posted.</>,
        <>New here? <Link href={signUpHref}>Create a creator account</Link>.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>Sign in.</h2>
          <p>Welcome back to Digital Sukoon Creators.</p>
        </div>

        <AuthTabs active="signin" signInHref={signInHref} signUpHref={signUpHref} />

        <form onSubmit={handleSubmit} noValidate className="auth-form">
          <AuthField
            id="lemail" label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
            value={email} onChange={(v) => { setEmail(v); if (error) setError(""); }}
            onBlur={() => setEmailBlurred(true)} error={emailErr}
          />
          <AuthField
            id="lpw" label="Password" type="password" autoComplete="current-password" placeholder="Your password"
            value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} error={null}
            showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)}
          />
          <div className="auth-row">
            <span className="auth-fine">For creators who own or manage their pages.</span>
            <button type="button" onClick={() => setForgotOpen(true)} className="auth-link">Forgot password?</button>
          </div>
          {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
          <button type="submit" disabled={state !== "idle" || !hydrated} className="auth-btn" aria-live="polite">
            {state === "idle" && (<><span>Sign in</span><ArrowRight size={17} /></>)}
            {state === "loading" && (<><span className="auth-spinner" aria-hidden /><span>One moment…</span></>)}
            {state === "success" && (<><Check size={18} strokeWidth={3} /><span>Opening…</span></>)}
          </button>
        </form>

        <GoogleSignIn mode="signin" onSession={adoptSession} />
      </div>

      {forgotOpen && <ForgotPasswordModal initialEmail={email} onClose={() => setForgotOpen(false)} />}
    </AuthShell>
  );
}

function ForgotPasswordModal({ initialEmail, onClose }: { initialEmail: string; onClose: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    document.getElementById("femail")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailOk(email)) { setError("Please enter a valid email."); return; }
    setLoading(true); setError("");
    try {
      await apiFetch("/creator/auth/forgot-password", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
      setSent(true);
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="forgot-title">
        <button type="button" onClick={onClose} aria-label="Close" className="auth-modal-x"><X size={16} /></button>
        <h3 id="forgot-title">Forgot password?</h3>
        {sent ? (
          <p role="status">
            If there&apos;s a creator account for that email, a reset link is on its way. Check your inbox — and spam — in a minute or two. The link works for 24 hours.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form" noValidate>
            <p>Enter the email on your creator account and we&apos;ll send you a link to choose a new password.</p>
            <AuthField id="femail" label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={setEmail} error={null} />
            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
            <button type="submit" disabled={loading} className="auth-btn">{loading ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
      </div>
    </div>
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

