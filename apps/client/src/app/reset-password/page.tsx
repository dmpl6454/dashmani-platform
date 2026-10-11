"use client";
import { useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { AuthField, AuthShell } from "@/components/auth/shared";
import { useHydrated } from "@/lib/hooks/use-hydrated";

// Token-based reset in the website's design. Wire unchanged:
// POST /v1/client/auth/reset-password with { token, newPassword }.

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const hydrated = useHydrated();
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords do not match"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setLoading(true);
    setError("");
    try {
      await apiFetch("/client/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, newPassword: password }),
      });
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: any) {
      setError(err.message || "Reset failed. The link may have expired.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      kicker="CH 07 · Client portal"
      title={<>New <em>password.</em></>}
      lines={[
        <>Choose a strong password for your client account. The reset link is valid for 24 hours.</>,
        <>Remembered it? <Link href="/login">Sign in</Link>.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>Set a new password.</h2>
          <p>At least 8 characters. Longer and mixed is stronger.</p>
        </div>

        {done ? (
          <div className="auth-ok">Password reset. Taking you to sign in…</div>
        ) : !token ? (
          <div className="auth-err"><AlertCircle size={14} /> <span>Invalid reset link. Please request a new one from the sign-in page.</span></div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <AuthField id="rpw" label="New password" type="password" autoComplete="new-password" placeholder="At least 8 characters"
              value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} error={null}
              showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
            <AuthField id="rpw2" label="Confirm password" type="password" autoComplete="new-password" placeholder="Repeat it"
              value={confirm} onChange={(v) => { setConfirm(v); if (error) setError(""); }} error={null}
              showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
            <button type="submit" disabled={loading || !hydrated} className="auth-btn">
              {loading ? (<><span className="auth-spinner" aria-hidden /><span>Resetting…</span></>) : (<><span>Reset password</span><ArrowRight size={17} /></>)}
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <ResetPasswordForm />
    </Suspense>
  );
}
