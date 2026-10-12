"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch, ApiError, clearSession } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { useHydrated } from "@/lib/use-hydrated";
import { AuthFallback, AuthField, AuthShell, PasswordMeter } from "@/components/auth/shared";

// /reset-password?token=… from the reset email → POST /v1/creator/auth/reset-password. A reset
// signs the creator out everywhere (the API deletes every refresh token), so this tab's stored
// session is dropped too and the creator signs in with the new password.

/** The API rejects codes shorter than this as invalid; a cut-off link can't work, so don't ask. */
const MIN_TOKEN_LENGTH = 20;
const LINK_INVALID = "This reset link has expired, was already used, or was cut off. Ask for a new one from the sign-in page.";

function ResetForm() {
  const raw = useSearchParams().get("token");
  const token = raw && raw.trim().length >= MIN_TOKEN_LENGTH ? raw.trim() : null;
  const hydrated = useHydrated();
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading || !token) return;
    if (password.length < 8) { setError("Use at least 8 characters."); return; }
    setLoading(true); setError("");
    try {
      await apiFetch("/creator/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword: password }) });
      clearSession();
      setDone(true);
    } catch (err) {
      // A cut-off code fails the API's schema (VALIDATION_ERROR on `token`) rather than its lookup —
      // to the creator both mean the same thing: this link won't work. A VALIDATION_ERROR on the
      // new password ("That password is too long") still reads as the API wrote it.
      const badToken = err instanceof ApiError && (
        err.code === "INVALID_TOKEN"
        || (err.code === "VALIDATION_ERROR" && (!err.details?.length || err.details.some((d) => d.field === "token")))
      );
      setError(badToken ? LINK_INVALID : errorSentence(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      kicker="Creator portal · Reset password"
      title={<>New <em>password.</em></>}
      lines={[<>Choose a new password for your creator account. Reset links work for 24 hours and only once.</>]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>{done ? "Password changed." : "Choose a new password."}</h2>
          <p>{done ? "You've been signed out everywhere. Sign in with your new password." : "At least 8 characters."}</p>
        </div>
        {!token ? (
          <>
            <div role="alert" className="auth-err">
              <AlertCircle size={14} />{" "}
              <span>{raw ? LINK_INVALID : "This link is missing its reset code. Open the link from the email again, or ask for a new one."}</span>
            </div>
            <Link href="/login" className="auth-btn">Back to sign in <ArrowRight size={17} /></Link>
          </>
        ) : done ? (
          <Link href="/login" className="auth-btn">Sign in <ArrowRight size={17} /></Link>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <div>
              <AuthField id="rpw" label="New password" type="password" autoComplete="new-password" placeholder="At least 8 characters"
                value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} error={null}
                showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
              <PasswordMeter password={password} />
            </div>
            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
            <button type="submit" disabled={loading || !hydrated} className="auth-btn" aria-live="polite">
              {loading ? (<><span className="auth-spinner" aria-hidden /><span>Saving…</span></>) : (<><span>Save new password</span><ArrowRight size={17} /></>)}
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthFallback title="Choose a new password." />}>
      <ResetForm />
    </Suspense>
  );
}
