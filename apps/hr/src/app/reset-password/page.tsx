"use client";
import { useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Eye, EyeOff, Lock, AlertCircle, CheckCircle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

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
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Reset failed. The link may have expired.");
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: any) {
      setError(err.message || "Reset failed. The link may have expired.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)", fontFamily: "'Instagram Sans', system-ui, sans-serif" }}
    >
      <div className="bg-white/90 backdrop-blur-xl rounded-2xl p-8 w-full max-w-sm shadow-[0_8px_32px_rgba(0,0,0,0.08)] border border-[#E8E0D0]/60">
        <div className="flex items-center gap-2.5 mb-6">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <span className="font-bold text-[#1A1A1A] uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>
        <h1 className="font-serif text-[26px] text-[#1A1A1A] mb-1">Set new password</h1>
        <p className="text-sm text-[#7A7A7A] mb-6">Choose a strong password for your account.</p>

        {done ? (
          <div className="flex items-center gap-2.5 bg-[rgba(107,203,119,0.08)] border border-[rgba(107,203,119,0.25)] rounded-[10px] px-4 py-3.5">
            <CheckCircle className="h-5 w-5 text-[#6BCB77] flex-shrink-0" />
            <div>
              <p className="text-[13px] text-[#3a8a4a] font-semibold">Password reset successfully</p>
              <p className="text-[12px] text-[#7A7A7A] mt-0.5">Redirecting to sign in…</p>
            </div>
          </div>
        ) : !token ? (
          <p className="text-sm text-red-600 font-medium">Invalid reset link. Please request a new one.</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">New Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0]" />
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  className="w-full pl-11 pr-12 py-3.5 rounded-[10px] text-sm bg-white/80 border-[1.5px] border-[#E8E0D0] text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:border-[#F5D547] focus:shadow-[0_0_0_3px_rgba(245,213,71,0.15)] transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPass((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#F5D547]"
                >
                  {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0]" />
                <input
                  type={showPass ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  placeholder="Repeat password"
                  className="w-full pl-11 pr-4 py-3.5 rounded-[10px] text-sm bg-white/80 border-[1.5px] border-[#E8E0D0] text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:border-[#F5D547] focus:shadow-[0_0_0_3px_rgba(245,213,71,0.15)] transition-all"
                />
              </div>
            </div>
            {error && (
              <div className="flex items-center gap-2.5 bg-red-50/80 border border-red-200 rounded-[10px] px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <span className="text-[12.5px] text-red-600 font-medium">{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] disabled:opacity-50 transition-all"
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
    <Suspense
      fallback={
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)" }}
        >
          <div className="h-8 w-8 rounded-full border-[3px] border-[#1A1A1A]/10 border-t-[#F5D547] animate-spin" />
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
