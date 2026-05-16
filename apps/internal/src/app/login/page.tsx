"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [shake,    setShake]    = useState(false);

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
                    placeholder="you@digitalsukoon.com" required
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
            </form>
          </div>
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

        {/* Floating cards */}
        <div className="relative w-full h-full p-12">

          {/* Card 1 — Team overview */}
          <div className="absolute top-[10%] left-[8%] v3-card bg-surface p-5 min-w-[240px] pop-in d1" style={{ borderColor: "#1A1A1A" }}>
            <p className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-3">Team Overview</p>
            <div className="flex gap-4">
              {[{ l: "Active", v: "24", col: "text-success" }, { l: "Pending", v: "8", col: "text-attention" }, { l: "Tasks", v: "142", col: "text-indigo" }].map((s) => (
                <div key={s.l} className="text-center">
                  <p className={`font-display text-2xl font-semibold ${s.col}`}>{s.v}</p>
                  <p className="text-[10px] text-ink-4">{s.l}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Card 2 — Dark stat */}
          <div className="absolute top-[18%] right-[8%] v3-card bg-surface p-5 min-w-[140px] pop-in d2" style={{ borderColor: "#1A1A1A" }}>
            <p className="text-[10px] text-ink-4 mb-1">Projects Active</p>
            <p className="font-display text-4xl font-semibold text-ink leading-none">36</p>
            <p className="text-xs text-success mt-1 font-semibold">+18% this month</p>
          </div>

          {/* Card 3 — Content pipeline */}
          <div className="absolute top-[47%] left-[6%] v3-card-sm p-4 min-w-[200px] pop-in d3">
            <p className="text-sm font-bold text-ink">Content Pipeline</p>
            <p className="text-xs text-ink-4 mt-0.5">12 posts scheduled</p>
            <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full w-[65%] rounded-full bg-action" />
            </div>
          </div>

          {/* Card 4 — Efficiency */}
          <div className="absolute bottom-[18%] right-[12%] v3-card-sm p-5 text-center pop-in d4">
            <svg width="72" height="72" viewBox="0 0 80 80" className="mx-auto">
              <circle cx="40" cy="40" r="30" fill="none" stroke="#EDE7D2" strokeWidth="6" />
              <circle cx="40" cy="40" r="30" fill="none" stroke="#F5D547" strokeWidth="6"
                strokeDasharray={`${2 * Math.PI * 30 * 0.85} ${2 * Math.PI * 30 * 0.15}`}
                strokeLinecap="round" transform="rotate(-90 40 40)" />
            </svg>
            <p className="font-display text-xl font-semibold text-ink -mt-12 mb-8">85%</p>
            <p className="text-[10px] text-ink-4">Efficiency Score</p>
          </div>

          {/* Card 5 — Badge */}
          <div className="absolute bottom-[28%] left-[20%] flex items-center gap-2 bg-action rounded-full px-5 py-2.5 border-2 border-ink btn-3d pop-in d5">
            <div className="h-2 w-2 rounded-full bg-ink dot-pulse" />
            <span className="text-sm font-bold text-ink">Management Portal</span>
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
