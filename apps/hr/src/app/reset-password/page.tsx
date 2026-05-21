"use client";
import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

const IcLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
);
const IcEye = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
);
const IcEyeOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9 9 0 0 1 12 6c6.5 0 10 7 10 7a17 17 0 0 1-3.1 3.9"/><path d="M6.5 7.5C3.7 9.3 2 12 2 12s3.5 7 10 7c1.5 0 2.8-.3 4-.8"/><path d="M14 14a3 3 0 0 1-4-4"/></svg>
);
const IcCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg>
);
const IcAlert = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v.1"/></svg>
);
const IcArrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>
);

const Mark = ({ size = 32 }: { size?: number }) => (
  <div
    className="rounded-xl bg-[#1A1A1A] text-white grid place-items-center font-black tracking-widest flex-shrink-0"
    style={{ width: size, height: size, fontSize: size * 0.34 }}
  >
    DS
  </div>
);

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [pwFocused, setPwFocused] = useState(false);
  const [cfFocused, setCfFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords do not match"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Reset failed. The link may have expired.");
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Reset failed. The link may have expired.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FDFCF0] flex items-center justify-center px-4 relative overflow-hidden">
      {/* Ambient dots */}
      <div className="fixed inset-0 pointer-events-none opacity-50"
        style={{ backgroundImage: "radial-gradient(rgba(93,95,239,.18) 1px,transparent 1px)", backgroundSize: "22px 22px" }} />
      {/* Glow orbs */}
      <div className="fixed rounded-full pointer-events-none" style={{ top: "-80px", right: "-60px", width: "360px", height: "360px", background: "radial-gradient(circle, rgba(245,213,71,.35), transparent 65%)", filter: "blur(50px)" }} />
      <div className="fixed rounded-full pointer-events-none" style={{ bottom: "-60px", left: "-60px", width: "320px", height: "320px", background: "radial-gradient(circle, rgba(93,95,239,.22), transparent 65%)", filter: "blur(50px)" }} />

      <div className="relative z-10 w-full max-w-sm" style={{ animation: "auth-popIn .42s cubic-bezier(0.34,1.45,0.64,1) both" }}>
        <div className="v3-card p-7">
          {/* Header */}
          <div className="flex items-center gap-2.5 mb-7">
            <Mark size={34} />
            <div className="leading-tight">
              <p className="text-[13.5px] font-bold text-[#1A1A1A]">Digital Sukoon</p>
              <p className="text-[11px] text-[#6C6555] font-medium -mt-0.5">Employee Portal</p>
            </div>
          </div>

          <h1 className="font-display text-[28px] font-semibold text-[#1A1A1A] leading-tight mb-1">Set new password</h1>
          <p className="text-[13px] text-[#6C6555] font-medium mb-6">Choose a strong password for your account.</p>

          {done ? (
            <div className="flex items-center gap-3 bg-[#EDF4EE] border border-[#4A7C52]/25 rounded-[14px] px-4 py-4" style={{ animation: "auth-fadeUp .3s ease-out" }}>
              <div className="w-9 h-9 rounded-xl bg-[#4A7C52] grid place-items-center shrink-0 text-white">
                <IcCheck />
              </div>
              <div>
                <p className="text-[13px] text-[#4A7C52] font-bold">Password reset successfully</p>
                <p className="text-[12px] text-[#6C6555] mt-0.5">Redirecting to sign in…</p>
              </div>
            </div>
          ) : !token ? (
            <div className="flex items-center gap-3 bg-[#FDECEA] border border-[#B83728]/25 rounded-[14px] px-4 py-4">
              <div className="w-9 h-9 rounded-xl bg-[#B83728] grid place-items-center shrink-0 text-white">
                <IcAlert />
              </div>
              <div>
                <p className="text-[13px] text-[#B83728] font-bold">Invalid reset link</p>
                <p className="text-[12px] text-[#6C6555] mt-0.5">Please request a new one from the login page.</p>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* New password */}
              <div className={`auth-field-wrap${pwFocused ? " is-focused" : ""}${password ? " is-filled" : ""}`}>
                <span className="auth-field-icon"><IcLock /></span>
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  onFocus={() => setPwFocused(true)}
                  onBlur={() => setPwFocused(false)}
                  className="auth-field pr-12"
                  aria-label="New password"
                />
                <label className="auth-field-label">New password</label>
                <button
                  type="button"
                  aria-label={showPass ? "Hide password" : "Show password"}
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9C947C] hover:text-[#1A1A1A] p-1 rounded-md transition-colors"
                >
                  {showPass ? <IcEye /> : <IcEyeOff />}
                </button>
              </div>

              {/* Confirm password */}
              <div className={`auth-field-wrap${cfFocused ? " is-focused" : ""}${confirm ? " is-filled" : ""}${confirm && password && confirm !== password ? " error" : ""}`}>
                <span className="auth-field-icon"><IcLock /></span>
                <input
                  type={showPass ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  onFocus={() => setCfFocused(true)}
                  onBlur={() => setCfFocused(false)}
                  className={`auth-field${confirm && password && confirm !== password ? " error" : ""}${confirm && password && confirm === password ? " success" : ""}`}
                  aria-label="Confirm password"
                />
                <label className="auth-field-label">Confirm password</label>
                {confirm && password && confirm === password && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4A7C52]">
                    <IcCheck />
                  </span>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2.5 bg-[#FDECEA] border border-[#B83728]/25 rounded-[14px] px-3 py-2.5">
                  <IcAlert />
                  <span className="text-[12.5px] text-[#B83728] font-semibold">{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-3d w-full flex items-center justify-center gap-2 py-3.5 rounded-full bg-[#1A1A1A] text-white font-bold text-[14px] disabled:opacity-50 transition-all"
                aria-live="polite"
              >
                {loading ? (
                  <><span className="h-[18px] w-[18px] border-[2.5px] border-white/35 border-t-white rounded-full" style={{ animation: "auth-spin .7s linear infinite" }} /><span>Resetting…</span></>
                ) : (
                  <><span>Reset Password</span><IcArrow /></>
                )}
              </button>

              <p className="text-[11px] text-[#9C947C] text-center">
                Remembered it?{" "}
                <a href="/login" className="text-[#5D5FEF] font-semibold hover:underline">Back to sign in</a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[#FDFCF0] flex items-center justify-center">
          <div className="h-8 w-8 rounded-full border-[3px] border-[#1A1A1A]/10 border-t-[#F5D547]" style={{ animation: "auth-spin .7s linear infinite" }} />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
