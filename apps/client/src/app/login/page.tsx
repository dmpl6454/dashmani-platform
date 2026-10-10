"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, AlertCircle, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { useSearchParams } from "next/navigation";
import { nextQueryFor, safeNextValue } from "@/lib/safe-next";
import { AuthField, AuthShell, AuthTabs } from "@/components/auth/shared";

// The client sign-in page, in the website's design (see components/auth/shared.tsx).
// Wire unchanged: useAuth().login() → POST /v1/client/auth/login, the same token
// keys, the forgot-password modal → POST /v1/client/auth/forgot-password, and a
// same-site ?next= carried through to the sign-up page.

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function LoginForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const [forgotOpen, setForgotOpen] = useState(false);

  const emailErr = emailBlurred && email && !emailOk(email) ? "Please enter a valid email" : null;
  const nextParam = useSearchParams().get("next");
  const bookingIntent = (safeNextValue(nextParam) ?? "").startsWith("/campaigns");
  const signInHref = `/login${nextQueryFor(nextParam)}`;
  const signUpHref = `/signup${nextQueryFor(nextParam)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !emailOk(email) || !password) {
      setEmailBlurred(true);
      if (!password) setError("Password is required");
      return;
    }
    setSubmitState("loading");
    try {
      await login(email, password);
      setSubmitState("success");
    } catch (err: any) {
      setError(err.message || "Invalid email or password.");
      setSubmitState("idle");
    }
  }

  return (
    <AuthShell
      kicker="CH 07 · Client portal"
      title={<>Your <em>network,</em><br />one room.</>}
      lines={[
        <>Book promotion on our pages, upload the creative, and watch every post go live with its link and numbers.</>,
        <>Review drafts, leave notes, approve in a tap. Facebook, Instagram, YouTube and Snapchat, in one place.</>,
        <>New here? <Link href={signUpHref}>Create a free account</Link> to book a campaign on our network.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>Sign in.</h2>
          <p>{bookingIntent ? "Sign in to continue to your campaign booking." : "Your studio is right where you left it."}</p>
        </div>

        <AuthTabs active="signin" signInHref={signInHref} signUpHref={signUpHref} />

        <form onSubmit={handleSubmit} noValidate className="auth-form">
          <AuthField
            id="cemail" label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@company.com"
            value={email}
            onChange={(v) => { setEmail(v); if (error) setError(""); }}
            onBlur={() => setEmailBlurred(true)}
            error={emailErr}
          />
          <AuthField
            id="cpw" label="Password" type="password" autoComplete="current-password" placeholder="Your password"
            value={password}
            onChange={(v) => { setPassword(v); if (error) setError(""); }}
            error={null}
            showPass={showPass}
            onToggleShowPass={() => setShowPass((s) => !s)}
          />
          <div className="auth-row">
            <span className="auth-fine">Access is for Digital Sukoon clients.</span>
            <button type="button" onClick={() => setForgotOpen(true)} className="auth-link">Forgot password?</button>
          </div>
          {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
          <button type="submit" disabled={submitState !== "idle"} className="auth-btn" aria-live="polite">
            {submitState === "idle" && (<><span>Enter the portal</span><ArrowRight size={17} /></>)}
            {submitState === "loading" && (<><span className="auth-spinner" aria-hidden /><span>One moment…</span></>)}
            {submitState === "success" && (<><Check size={18} strokeWidth={3} /><span>Opening…</span></>)}
          </button>
        </form>
      </div>

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
    </AuthShell>
  );
}

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      await apiFetch("/client/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err: any) { setError(err.message || "Something went wrong"); }
    finally { setLoading(false); }
  }
  return (
    <div className="auth-modal-overlay" onClick={onClose}>
      <div className="auth-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="forgot-title">
        <button type="button" onClick={onClose} aria-label="Close" className="auth-modal-x"><X size={16} /></button>
        <h3 id="forgot-title">Forgot password?</h3>
        {sent ? (
          <p>If that email is registered, a reset link is on its way. Check your inbox, and spam, within a minute. The link is valid for 24 hours.</p>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <p>Enter the email on your client account and we will send a reset link.</p>
            <AuthField id="femail" label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={setEmail} error={null} />
            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
            <button type="submit" disabled={loading} className="auth-btn">{loading ? "Sending…" : "Send reset link"}</button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ClientLoginPage() {
  // safeNext()/nextQuery() read the URL; Suspense keeps the static prerender happy.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
