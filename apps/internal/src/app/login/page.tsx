"use client";
import { useState, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { Eye, EyeOff, Mail, Lock } from "lucide-react";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [shake, setShake] = useState(false);

  useEffect(() => { setMounted(true); }, []);

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
    } finally {
      setLoading(false);
    }
  }

  const inputWrapperClass = (field: string) =>
    `relative flex items-center w-full rounded-xl transition-all duration-300 ${
      focusedField === field
        ? "bg-[#FFFEF8] border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
        : "bg-[#FFF8E1]/60 border-[1.5px] border-[#F0EAD8] hover:border-[#E8D8B4]"
    }`;

  return (
    <div className="min-h-screen flex overflow-hidden" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)", fontFamily: "'Instagram Sans', system-ui, sans-serif" }}>

      {/* Animated Background Orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[10%] left-[15%] w-[400px] h-[400px] rounded-full opacity-[0.08]" style={{ background: "radial-gradient(circle, #F5D547 0%, transparent 70%)", animation: "crx-float1 12s ease-in-out infinite" }} />
        <div className="absolute bottom-[15%] right-[10%] w-[300px] h-[300px] rounded-full opacity-[0.06]" style={{ background: "radial-gradient(circle, #B8956A 0%, transparent 70%)", animation: "crx-float2 10s ease-in-out infinite" }} />
        <div className="absolute top-[50%] left-[50%] w-[250px] h-[250px] rounded-full opacity-[0.04]" style={{ background: "radial-gradient(circle, #F5D547 0%, transparent 70%)", animation: "crx-float3 14s ease-in-out infinite" }} />
      </div>

      {/* LEFT -- Form */}
      <div
        className="w-full lg:w-[44%] min-w-0 lg:min-w-[380px] flex flex-col justify-between p-6 sm:p-9 relative z-10"
        style={{ animation: mounted ? "crx-fadeInLeft 0.6s ease-out" : "none" }}
      >
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <span className="font-bold text-[#1A1A1A] uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>

        <div className="max-w-[380px] w-full mx-auto">
          {/* Brand heading */}
          <div className="text-center mb-8" style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.15s both" : "none" }}>
            <h1 className="font-serif text-[36px] font-normal text-[#1A1A1A] leading-tight">
              Management Portal
            </h1>
            <p className="text-sm text-[#7A7A7A] mt-2">
              Sign in to manage your team &amp; operations
            </p>
          </div>

          {/* Glass card */}
          <div
            className={`bg-white/60 backdrop-blur-xl rounded-2xl border border-white/50 shadow-[0_8px_40px_rgba(0,0,0,0.06)] p-7 ${shake ? "animate-[shake_0.5s_ease-in-out]" : ""}`}
            style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.3s both" : "none" }}
          >
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email</label>
                <div className={inputWrapperClass("email")}>
                  <Mail className="h-4 w-4 text-[#B0B0B0] ml-3.5 shrink-0" />
                  <input
                    type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@digitalsukoon.com" required
                    onFocus={() => setFocusedField("email")} onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent px-3 py-3.5 text-sm outline-none text-[#1A1A1A] placeholder:text-[#B0B0B0]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Password</label>
                <div className={inputWrapperClass("password")}>
                  <Lock className="h-4 w-4 text-[#B0B0B0] ml-3.5 shrink-0" />
                  <input
                    type={showPass ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password" required
                    onFocus={() => setFocusedField("password")} onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent px-3 py-3.5 text-sm outline-none text-[#1A1A1A] placeholder:text-[#B0B0B0]"
                  />
                  <button type="button" onClick={() => setShowPass(!showPass)} className="pr-3.5 text-[#B0B0B0] hover:text-[#F5D547] transition-colors shrink-0">
                    {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm text-[#E74C3C] bg-red-50/60 border border-red-100 rounded-lg px-3 py-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  {error}
                </div>
              )}

              <button
                type="submit" disabled={loading}
                className="group w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_8px_32px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all duration-300 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </button>
            </form>
          </div>
        </div>

        <div />
      </div>

      {/* RIGHT -- Visual Showcase */}
      <div className="hidden lg:block flex-1 relative overflow-hidden" style={{ borderRadius: "24px 0 0 24px", animation: mounted ? "crx-fadeInRight 0.7s ease-out 0.2s both" : "none" }}>
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, #C4A882 0%, #A08060 40%, #8B7355 100%)" }} />
        <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 30% 40%, rgba(245,213,71,0.15) 0%, transparent 50%), radial-gradient(circle at 70% 80%, rgba(0,0,0,0.1) 0%, transparent 40%)" }} />

        <div className="relative w-full h-full min-h-screen">
          {/* Analytics Card */}
          <div className="absolute top-[8%] left-[10%]" style={{ animation: "crx-float1 6s ease-in-out infinite" }}>
            <div className="bg-white/95 rounded-2xl px-5 py-4 shadow-[0_4px_24px_rgba(0,0,0,0.08)] backdrop-blur-xl min-w-[240px]">
              <div className="text-sm font-semibold text-[#1A1A1A] mb-2">Team Overview</div>
              <div className="flex gap-3">
                {[{ l: "Active", v: "24", c: "#6BCB77" }, { l: "Pending", v: "8", c: "#F5D547" }, { l: "Tasks", v: "142", c: "#3498DB" }].map((s) => (
                  <div key={s.l} className="text-center">
                    <div className="text-xl font-light font-serif text-[#1A1A1A]">{s.v}</div>
                    <div className="text-[10px] text-[#7A7A7A]">{s.l}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Dark Stat */}
          <div className="absolute top-[20%] right-[10%]" style={{ animation: "crx-float3 8s ease-in-out infinite" }}>
            <div className="bg-[#2B2B2B] rounded-2xl px-5 py-4 shadow-[0_8px_40px_rgba(0,0,0,0.1)] text-white min-w-[140px]">
              <div className="text-[11px] text-white/50 mb-1">Projects</div>
              <div className="text-[32px] font-light font-serif leading-none">36</div>
              <div className="flex items-center gap-1 mt-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6BCB77" strokeWidth="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /></svg>
                <span className="text-[11px] text-[#6BCB77]">+18%</span>
              </div>
            </div>
          </div>

          {/* Content Card */}
          <div className="absolute top-[45%] left-[8%]" style={{ animation: "crx-float2 7s ease-in-out infinite" }}>
            <div className="bg-[#FFF3C4] rounded-2xl px-5 py-3.5 shadow-[0_4px_24px_rgba(0,0,0,0.08)] min-w-[200px]">
              <div className="text-sm font-semibold text-[#1A1A1A]">Content Pipeline</div>
              <div className="text-xs text-[#7A7A7A] mt-1">12 posts scheduled</div>
              <div className="mt-2 h-2 rounded-full bg-white overflow-hidden">
                <div className="h-full w-[65%] rounded-full bg-[#F5D547]" />
              </div>
            </div>
          </div>

          {/* Progress Ring */}
          <div className="absolute bottom-[15%] right-[15%]" style={{ animation: "crx-float1 6s ease-in-out infinite" }}>
            <div className="bg-white/90 rounded-2xl p-5 shadow-[0_4px_24px_rgba(0,0,0,0.08)] backdrop-blur-xl text-center">
              <svg width="80" height="80" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="30" fill="none" stroke="#F0EAD8" strokeWidth="5" />
                <circle cx="40" cy="40" r="30" fill="none" stroke="#F5D547" strokeWidth="5" strokeDasharray={`${2 * Math.PI * 30 * 0.85} ${2 * Math.PI * 30 * 0.15}`} strokeLinecap="round" transform="rotate(-90 40 40)" />
              </svg>
              <div className="-mt-[55px] mb-[18px]">
                <div className="text-xl font-light font-serif text-[#1A1A1A]">85%</div>
                <div className="text-[9px] text-[#B0B0B0]">Efficiency</div>
              </div>
            </div>
          </div>

          {/* Time Pill */}
          <div className="absolute bottom-[25%] left-[20%]" style={{ animation: "crx-float2 7s ease-in-out infinite" }}>
            <div className="bg-[#F5D547] rounded-full px-4 py-2 shadow-[0_4px_16px_rgba(245,213,71,0.4)] flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span className="text-[13px] font-semibold text-[#1A1A1A]">Admin</span>
              <span className="text-[11px] text-black/50">Portal</span>
            </div>
          </div>

          {/* Decorative Dots */}
          <div className="absolute bottom-[5%] left-[5%] opacity-15">
            {Array.from({ length: 5 }).map((_, r) => (
              <div key={r} className="flex gap-2 mb-2">
                {Array.from({ length: 8 }).map((_, c) => (
                  <div key={c} className="w-1 h-1 rounded-full bg-white" />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Shake keyframe (injected via style tag for the error animation) */}
      <style jsx global>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
      `}</style>
    </div>
  );
}
