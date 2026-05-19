"use client";
import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { Eye, EyeOff, Lock } from "lucide-react";
import { AuthStyles } from "@/components/auth/shared";

function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPass, setShowPass] = useState(false);
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
    <main className="min-h-screen w-full bg-bg relative overflow-hidden text-ink flex items-center justify-center px-4">
      <div className="fixed inset-0 pointer-events-none" aria-hidden>
        <div className="aurora-a aurora-1" style={{ top: "-12%", left: "-8%", width: "620px", height: "620px" }} />
        <div className="aurora-a aurora-2" style={{ top: "30%", right: "-10%", width: "560px", height: "560px" }} />
        <div className="aurora-a aurora-3" style={{ bottom: "-15%", left: "25%", width: "520px", height: "520px" }} />
        <div className="grain" />
      </div>

      <section className="relative z-10 w-full max-w-[440px]">
        <div className="paper p-8 sm:p-10">
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-bg border border-ink-4/30">
            <p className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-ink-3 font-semibold">Reset · your password</p>
          </div>

          <div className="text-center mb-7">
            <h1 className="font-display text-[28px] font-semibold text-ink leading-none">Set new password</h1>
            <p className="font-display italic text-ink-3 text-[14px] mt-2 max-w-[300px] mx-auto leading-snug">
              Choose a strong password for your client account.
            </p>
          </div>

          {done ? (
            <div className="text-center py-4">
              <p className="text-sage-deep font-semibold">Password reset successfully!</p>
              <p className="text-sm text-ink-4 mt-1">Redirecting to sign in…</p>
            </div>
          ) : !token ? (
            <p className="text-sm text-danger font-medium">
              Invalid reset link. Please request a new one from the sign-in page.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5">New Password</label>
                <div className="flex items-center border-2 border-ink/15 rounded-xl hover:border-ink/25 focus-within:border-indigo transition-colors bg-white">
                  <Lock className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    placeholder="At least 8 characters"
                    className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="pr-3.5 text-ink-4 hover:text-indigo shrink-0"
                    aria-label={showPass ? "Hide password" : "Show password"}
                  >
                    {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5">Confirm Password</label>
                <div className="flex items-center border-2 border-ink/15 rounded-xl hover:border-ink/25 focus-within:border-indigo transition-colors bg-white">
                  <Lock className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />
                  <input
                    type={showPass ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    placeholder="Repeat password"
                    className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                  />
                </div>
              </div>
              {error && (
                <p className="text-xs text-danger font-semibold bg-danger-bg border border-danger/20 rounded-xl px-3 py-2">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="btn-pill w-full py-3.5 rounded-full bg-ink text-white text-sm font-bold disabled:opacity-50 transition-all"
              >
                {loading ? "Resetting…" : "Reset Password"}
              </button>
            </form>
          )}
        </div>
      </section>

      <AuthStyles />
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-bg">
          <div
            className="h-8 w-8 rounded-full border-[3px] border-ink/10 border-t-indigo"
            style={{ animation: "spin 0.7s linear infinite" }}
          />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
