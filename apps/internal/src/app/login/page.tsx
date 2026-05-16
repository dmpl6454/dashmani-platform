"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { Eye, EyeOff, Mail, Lock, X } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [shake,    setShake]    = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message || "Login failed");
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally { setLoading(false); }
  }

  const fieldCls = (focused: boolean) =>
    `flex items-center border-2 rounded-xl transition-all ${
      focused ? "border-indigo bg-surface" : "border-ink/15 bg-surface hover:border-ink/25"
    }`;

  return (
    <div className="min-h-screen flex bg-bg overflow-hidden">
      {/* Subtle dot-grid background */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(circle, rgba(26,26,26,0.06) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* ── Left — form ── */}
      <div className="w-full lg:w-[480px] shrink-0 flex flex-col justify-between p-8 sm:p-12 relative z-10 pop-in">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full border-2 border-ink" />
          <span className="font-bold text-ink uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>

        {/* Form area */}
        <div className="max-w-[360px] w-full mx-auto">
          <div className="mb-8 fade-up d1">
            <h1 className="font-display text-[36px] font-semibold text-ink leading-tight">Management Portal</h1>
            <p className="text-sm text-ink-3 mt-2">Sign in to manage your team &amp; operations</p>
          </div>

          <div className={`v3-card p-7 fade-up d2 ${shake ? "[animation:shake_0.4s_ease]" : ""}`}>
            <form onSubmit={handleSubmit} className="space-y-5">
              <FieldInput
                label="Email"
                icon={<Mail className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />}
                input={
                  <input
                    type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email address" required
                    className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                  />
                }
              />
              <FieldInput
                label="Password"
                icon={<Lock className="h-4 w-4 text-ink-4 ml-3.5 shrink-0" />}
                input={
                  <input
                    type={showPass ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password" required
                    className="flex-1 bg-transparent px-3 py-3 text-sm text-ink outline-none placeholder:text-ink-4"
                  />
                }
                action={
                  <button type="button" onClick={() => setShowPass(v => !v)} className="pr-3.5 text-ink-4 hover:text-indigo transition-colors shrink-0">
                    {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                }
              />

              {error && (
                <div className="flex items-center gap-2 text-sm text-danger bg-danger-bg border border-danger/20 rounded-xl px-3 py-2.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  {error}
                </div>
              )}

              <button
                type="submit" disabled={loading}
                className="w-full py-3.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {loading ? (
                  <><div className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white" style={{ animation: "spin 0.7s linear infinite" }} /> Signing in…</>
                ) : "Sign in to Portal"}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setForgotOpen(true)}
                  className="text-xs text-ink-4 hover:text-indigo underline-offset-2 hover:underline transition-colors"
                >
                  Forgot your password?
                </button>
              </div>
            </form>
          </div>

          {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
        </div>

        <p className="text-xs text-ink-4 text-center">© {new Date().getFullYear()} Digital Sukoon. All rights reserved.</p>
      </div>

      {/* ── Right — illustration panel ── */}
      <div className="hidden lg:flex flex-1 relative overflow-hidden items-center justify-center bg-ink">
        {/* Ink texture */}
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.15) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
        }} />
        <div className="absolute inset-0 bg-gradient-to-br from-ink via-ink-2 to-[#2a2028]" />

        {/* Branding content */}
        <div className="relative w-full h-full p-12 flex flex-col items-center justify-center">
          {/* Central branding */}
          <div className="text-center pop-in d1 z-10">
            <div className="h-20 w-20 rounded-2xl border-4 border-white/20 bg-white/10 flex items-center justify-center mx-auto mb-6">
              <img src="/logo.svg" alt="Digital Sukoon" className="h-12 w-12 rounded-xl" />
            </div>
            <p className="font-bold text-white uppercase tracking-[3px] text-xs mb-2 opacity-60">Digital Sukoon</p>
            <h2 className="font-display text-3xl font-semibold text-white leading-tight mb-3">Management Portal</h2>
            <p className="text-white/50 text-sm max-w-[240px] mx-auto leading-relaxed">
              A unified workspace for your team's operations, content, and growth.
            </p>
          </div>

          {/* Decorative pill */}
          <div className="absolute bottom-[22%] left-1/2 -translate-x-1/2 flex items-center gap-2 bg-action rounded-full px-5 py-2.5 border-2 border-ink btn-3d pop-in d3">
            <div className="h-2 w-2 rounded-full bg-ink dot-pulse" />
            <span className="text-sm font-bold text-ink">Secure &amp; Private</span>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-5px); }
          40%, 80% { transform: translateX(5px); }
        }
      `}</style>
    </div>
  );
}

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await apiFetch("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm">
      <div className="v3-card bg-surface p-7 w-full max-w-sm mx-4 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-ink-4 hover:text-ink" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
        <h2 className="font-display text-xl font-semibold text-ink mb-1">Forgot password?</h2>
        {sent ? (
          <p className="text-sm text-ink-3 mt-3">
            If that email is registered, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-4">
            <p className="text-sm text-ink-3">Enter your email and we'll send you a reset link.</p>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              placeholder="Enter your email address"
              className="w-full px-4 py-3 border-2 border-ink/15 rounded-xl text-sm text-ink bg-bg placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <button
              type="submit" disabled={loading}
              className="w-full py-3 rounded-full bg-ink text-white text-sm font-bold hover:bg-ink-2 disabled:opacity-50 transition-all"
            >
              {loading ? "Sending…" : "Send Reset Link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function FieldInput({ label, icon, input, action }: { label: string; icon: React.ReactNode; input: React.ReactNode; action?: React.ReactNode }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label className="block text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5">{label}</label>
      <div
        className={`flex items-center border-2 rounded-xl transition-all ${focused ? "border-indigo" : "border-ink/15 hover:border-ink/25"}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {icon}
        {input}
        {action}
      </div>
    </div>
  );
}
