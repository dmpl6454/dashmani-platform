"use client";
import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { Eye, EyeOff, Lock } from "lucide-react";

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
      await apiFetch("/auth/reset-password", {
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
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="v3-card bg-surface p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-8 w-8 rounded-full border-2 border-ink" />
          <span className="font-bold text-ink uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink mb-1">Set new password</h1>
        <p className="text-sm text-ink-4 mb-6">Choose a strong password for your account.</p>

        {done ? (
          <div className="text-center py-4">
            <p className="text-success font-semibold">Password reset successfully!</p>
            <p className="text-sm text-ink-4 mt-1">Redirecting to login…</p>
          </div>
        ) : !token ? (
          <p className="text-sm text-danger">Invalid reset link. Please request a new one.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5">New Password</label>
              <div className="flex items-center border-2 border-ink/15 rounded-xl hover:border-ink/25 focus-within:border-indigo transition-colors">
                <Lock className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />
                <input
                  type={showPass ? "text" : "password"} value={password}
                  onChange={(e) => setPassword(e.target.value)} required minLength={8}
                  placeholder="At least 8 characters"
                  className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                />
                <button type="button" onClick={() => setShowPass(v => !v)} className="pr-3.5 text-ink-4 hover:text-indigo shrink-0">
                  {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5">Confirm Password</label>
              <div className="flex items-center border-2 border-ink/15 rounded-xl hover:border-ink/25 focus-within:border-indigo transition-colors">
                <Lock className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />
                <input
                  type={showPass ? "text" : "password"} value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} required
                  placeholder="Repeat password"
                  className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                />
              </div>
            </div>
            {error && <p className="text-xs text-danger bg-danger-bg border border-danger/20 rounded-xl px-3 py-2">{error}</p>}
            <button
              type="submit" disabled={loading}
              className="w-full py-3.5 rounded-full bg-ink text-white text-sm font-bold hover:bg-ink-2 disabled:opacity-50 transition-all"
            >
              {loading ? "Resetting…" : "Reset Password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-bg"><div className="h-8 w-8 rounded-full border-[3px] border-ink/10 border-t-indigo" style={{ animation: "spin 0.7s linear infinite" }} /></div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
