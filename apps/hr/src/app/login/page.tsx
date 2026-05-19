"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useHrAuth } from "@/lib/auth";
import { Eye, EyeOff, CheckCircle, Mail, Lock, User, Phone, AlertCircle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useHrAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  const [mounted, setMounted] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/hr/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Login failed");
      login(data.data.accessToken, data.data.refreshToken, data.data.user);
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccessMsg("");
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/hr/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone: phone || undefined, password }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Registration failed");
      setSuccessMsg(data.data.message || "Account created! Wait for admin approval.");
      setTimeout(() => { setMode("login"); setIdentifier(email); setSuccessMsg(""); }, 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const inputClass = (field: string) =>
    `w-full pl-11 pr-4 py-3.5 rounded-[10px] text-sm outline-none transition-all duration-300 ${
      focusedField === field
        ? "bg-white/90 border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
        : "bg-white/60 border-[1.5px] border-[#E8E0D0] hover:border-[#D8D0C0]"
    } text-[#1A1A1A] placeholder:text-[#B0B0B0] backdrop-blur-sm`;

  const inputClassNoIcon = (field: string) =>
    `w-full px-4 py-3.5 rounded-[10px] text-sm outline-none transition-all duration-300 ${
      focusedField === field
        ? "bg-white/90 border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
        : "bg-white/60 border-[1.5px] border-[#E8E0D0] hover:border-[#D8D0C0]"
    } text-[#1A1A1A] placeholder:text-[#B0B0B0] backdrop-blur-sm`;

  const passwordStrength = password.length >= 10 ? 4 : password.length >= 7 ? 3 : password.length >= 4 ? 2 : password.length >= 1 ? 1 : 0;

  return (
    <div className="min-h-screen flex overflow-hidden relative" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)", fontFamily: "'Instagram Sans', system-ui, sans-serif" }}>
      {/* Animated Background Orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[#F5D547]/10 blur-[100px]" style={{ animation: "crx-float1 8s ease-in-out infinite" }} />
        <div className="absolute top-1/2 -right-24 w-80 h-80 rounded-full bg-[#E8D5B7]/20 blur-[80px]" style={{ animation: "crx-float2 10s ease-in-out infinite" }} />
        <div className="absolute -bottom-20 left-1/3 w-72 h-72 rounded-full bg-[#F5D547]/8 blur-[90px]" style={{ animation: "crx-float3 12s ease-in-out infinite" }} />
      </div>

      {/* LEFT -- Form */}
      <div
        className="w-full lg:w-[44%] min-w-0 lg:min-w-[380px] flex flex-col justify-between p-6 sm:p-9 relative z-10"
        style={{ animation: mounted ? "crx-fadeInLeft 0.6s ease-out" : "none" }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <span className="font-bold text-[#1A1A1A] uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>

        {/* Form Center */}
        <div className="max-w-[380px] w-full mx-auto">
          {/* Brand Element */}
          <div className="flex justify-center mb-6" style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.1s both" : "none" }}>
            <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-[#F5D547] to-[#E8C83A] flex items-center justify-center shadow-[0_8px_32px_rgba(245,213,71,0.3)]">
              <span className="font-serif text-2xl font-bold text-[#1A1A1A]">DS</span>
            </div>
          </div>

          <h1
            className="font-serif text-[32px] font-normal text-[#1A1A1A] text-center mb-1"
            style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.15s both" : "none" }}
          >
            {mode === "login" ? "Welcome back" : "Create an account"}
          </h1>
          <p
            className="text-sm text-[#7A7A7A] text-center mb-1"
            style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.2s both" : "none" }}
          >
            {mode === "login" ? "Sign in to Employee Portal" : "Sign up and get started"}
          </p>
          <p
            className="text-xs text-[#B0B0B0] text-center mb-7 italic"
            style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.25s both" : "none" }}
          >
            Empowering your digital journey
          </p>

          {/* Success */}
          {successMsg && (
            <div className="mb-5 bg-[rgba(107,203,119,0.08)] border border-[rgba(107,203,119,0.25)] rounded-[10px] px-4 py-3.5 flex items-center gap-2.5 backdrop-blur-sm" style={{ animation: "crx-slideDown 0.3s ease-out" }}>
              <CheckCircle className="h-5 w-5 text-[#6BCB77] flex-shrink-0" />
              <span className="text-[13px] text-[#6BCB77] font-medium">{successMsg}</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-5 bg-red-50/80 border border-red-200 rounded-[10px] px-4 py-3.5 flex items-center gap-2.5 backdrop-blur-sm" style={{ animation: "crx-slideDown 0.3s ease-out" }}>
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
              <span className="text-[13px] text-red-600 font-medium">{error}</span>
            </div>
          )}

          {/* Mode Toggle */}
          <div
            className="flex mb-6 bg-white/40 rounded-full p-1 backdrop-blur-md border border-[#E8E0D0]/50"
            style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.3s both" : "none" }}
          >
            <button
              type="button"
              onClick={() => { setMode("login"); setError(""); setSuccessMsg(""); }}
              className={`flex-1 py-2.5 text-sm font-medium rounded-full transition-all duration-300 ${
                mode === "login" ? "bg-[#1A1A1A] text-white shadow-md" : "text-[#7A7A7A] hover:text-[#1A1A1A]"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode("register"); setError(""); setSuccessMsg(""); }}
              className={`flex-1 py-2.5 text-sm font-medium rounded-full transition-all duration-300 ${
                mode === "register" ? "bg-[#1A1A1A] text-white shadow-md" : "text-[#7A7A7A] hover:text-[#1A1A1A]"
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Form Fields */}
          <div style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.35s both" : "none" }}>
            {mode === "login" ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email or Phone</label>
                  <div className="relative">
                    <Mail className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "identifier" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input
                      type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="you@example.com or +91..."
                      required
                      onFocus={() => setFocusedField("identifier")} onBlur={() => setFocusedField(null)}
                      className={inputClass("identifier")}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="text-xs text-[#7A7A7A] font-medium">Password</label>
                    <button type="button" onClick={() => setForgotOpen(true)} className="text-[11px] text-[#F5D547] font-semibold underline underline-offset-2">Forgot password?</button>
                  </div>
                  <div className="relative">
                    <Lock className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "password" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input
                      type={showPass ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password" required
                      onFocus={() => setFocusedField("password")} onBlur={() => setFocusedField(null)}
                      className={`${inputClass("password")} !pr-12`}
                    />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#F5D547] transition-colors">
                      {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <button
                  type="submit" disabled={loading}
                  className="w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all duration-300 relative overflow-hidden group"
                >
                  <span className="relative z-10">{loading ? "Signing in..." : "Sign in"}</span>
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                </button>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div style={{ animation: "crx-slideDown 0.3s ease-out" }}>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Full name</label>
                  <div className="relative">
                    <User className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "name" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter your full name" required onFocus={() => setFocusedField("name")} onBlur={() => setFocusedField(null)} className={inputClass("name")} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email</label>
                  <div className="relative">
                    <Mail className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "email" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required onFocus={() => setFocusedField("email")} onBlur={() => setFocusedField(null)} className={inputClass("email")} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Phone (optional)</label>
                  <div className="relative">
                    <Phone className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "phone" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 9876543210" onFocus={() => setFocusedField("phone")} onBlur={() => setFocusedField(null)} className={inputClass("phone")} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Password</label>
                  <div className="relative">
                    <Lock className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "pw" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input type={showPass ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimum 6 characters" required onFocus={() => setFocusedField("pw")} onBlur={() => setFocusedField(null)} className={`${inputClass("pw")} !pr-12`} />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#F5D547] transition-colors">
                      {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  </div>
                  {password.length > 0 && (
                    <div className="flex gap-1 mt-2">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className={`flex-1 h-[3px] rounded-full transition-colors duration-300 ${
                          passwordStrength >= i
                            ? passwordStrength >= 4 ? "bg-[#6BCB77]" : "bg-[#F5D547]"
                            : "bg-[#F0EAD8]"
                        }`} />
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Confirm Password</label>
                  <div className="relative">
                    <Lock className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors ${focusedField === "cpw" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter password" required onFocus={() => setFocusedField("cpw")} onBlur={() => setFocusedField(null)} className={inputClass("cpw")} />
                  </div>
                </div>
                <button
                  type="submit" disabled={loading}
                  className="w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all duration-300 relative overflow-hidden group"
                >
                  <span className="relative z-10">{loading ? "Creating Account..." : "Create Account"}</span>
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                </button>
                <p className="text-[11px] text-[#B0B0B0] text-center">After registration, an admin must approve your account before you can log in.</p>
              </form>
            )}
          </div>
        </div>

        {/* Bottom Links */}
        <div className="flex justify-between items-center text-[13px] text-[#7A7A7A]" style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.6s both" : "none" }}>
          <span>
            {mode === "login" ? "Don't have an account? " : "Have an account? "}
            <button
              onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setSuccessMsg(""); }}
              className="text-[#1A1A1A] font-semibold underline underline-offset-2"
            >
              {mode === "login" ? "Sign up" : "Sign in"}
            </button>
          </span>
        </div>
      </div>

      {/* RIGHT -- Visual Showcase */}
      <div
        className="hidden lg:block flex-1 relative overflow-hidden"
        style={{
          borderRadius: "24px 0 0 24px",
          animation: mounted ? "crx-fadeInRight 0.7s ease-out 0.2s both" : "none",
        }}
      >
        {/* Background */}
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, #C4A882 0%, #A08060 40%, #8B7355 100%)" }} />
        <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 30% 40%, rgba(245,213,71,0.15) 0%, transparent 50%), radial-gradient(circle at 70% 80%, rgba(0,0,0,0.1) 0%, transparent 40%)" }} />

        {/* Floating Cards */}
        <div className="relative w-full h-full min-h-screen">
          {/* Task Review Card */}
          <div className="absolute top-[6%] left-[8%]" style={{ animation: "crx-float1 6s ease-in-out infinite" }}>
            <div className="bg-[#FFF3C4] rounded-2xl px-5 py-3.5 shadow-[0_4px_24px_rgba(0,0,0,0.08)] flex items-center gap-3 min-w-[220px]">
              <div>
                <div className="text-sm font-semibold text-[#1A1A1A]">Daily Report</div>
                <div className="text-xs text-[#7A7A7A]">09:30am-10:00am</div>
              </div>
              <div className="w-2.5 h-2.5 rounded-full bg-[#F5D547]" style={{ animation: "crx-dotPulse 2s ease-in-out infinite" }} />
            </div>
          </div>

          {/* Stats Card */}
          <div className="absolute top-[18%] right-[8%]" style={{ animation: "crx-float3 8s ease-in-out infinite" }}>
            <div className="bg-[#2B2B2B] rounded-2xl px-5 py-4 shadow-[0_8px_40px_rgba(0,0,0,0.1)] text-white min-w-[140px]">
              <div className="text-[11px] text-white/50 mb-1">Employees</div>
              <div className="text-[32px] font-light font-serif leading-none">78</div>
              <div className="flex items-center gap-1 mt-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6BCB77" strokeWidth="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /></svg>
                <span className="text-[11px] text-[#6BCB77]">+12%</span>
              </div>
            </div>
          </div>

          {/* Calendar Widget */}
          <div className="absolute top-[38%] left-[10%]" style={{ animation: "crx-float2 7s ease-in-out infinite" }}>
            <div className="bg-white/95 rounded-2xl px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl min-w-[280px]">
              <div className="flex justify-between mb-3">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                  <div key={d} className="text-center w-8">
                    <div className="text-[10px] text-[#B0B0B0] mb-1">{d}</div>
                    <div className={`text-[15px] rounded-lg py-1 ${i === 3 ? "bg-[#1A1A1A] text-white font-bold" : i >= 5 ? "text-[#F5A623]" : "text-[#1A1A1A]"}`}>
                      {[22, 23, 24, 25, 26, 27, 28][i]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Meeting Card */}
          <div className="absolute bottom-[18%] left-[15%]" style={{ animation: "crx-float3 5s ease-in-out infinite" }}>
            <div className="bg-white/95 rounded-2xl px-5 py-4 shadow-[0_4px_24px_rgba(0,0,0,0.08)] backdrop-blur-xl min-w-[230px]">
              <div className="flex items-start justify-between mb-2.5">
                <div>
                  <div className="text-sm font-semibold text-[#1A1A1A]">Team Standup</div>
                  <div className="text-xs text-[#7A7A7A]">12:00pm~01:00pm</div>
                </div>
                <div className="w-2 h-2 rounded-full bg-[#F5D547] mt-1" />
              </div>
              <div className="flex">
                {["#E8D5B7", "#C4A882", "#A08060", "#8B7355"].map((c, i) => (
                  <div key={i} className="w-[30px] h-[30px] rounded-full border-[2.5px] border-white flex items-center justify-center text-[10px] text-white font-semibold" style={{ background: c, marginLeft: i > 0 ? "-8px" : "0" }}>
                    {["SK", "AK", "RP", "JK"][i]}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Progress Ring */}
          <div className="absolute bottom-[12%] right-[12%]" style={{ animation: "crx-float1 6s ease-in-out infinite" }}>
            <div className="bg-white/90 rounded-2xl p-5 shadow-[0_4px_24px_rgba(0,0,0,0.08)] backdrop-blur-xl text-center">
              <svg width="80" height="80" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="30" fill="none" stroke="#F0EAD8" strokeWidth="5" />
                <circle cx="40" cy="40" r="30" fill="none" stroke="#F5D547" strokeWidth="5" strokeDasharray={`${2 * Math.PI * 30 * 0.72} ${2 * Math.PI * 30 * 0.28}`} strokeLinecap="round" transform="rotate(-90 40 40)" />
              </svg>
              <div className="-mt-[55px] mb-[18px]">
                <div className="text-xl font-light font-serif text-[#1A1A1A]">72%</div>
                <div className="text-[9px] text-[#B0B0B0]">Completed</div>
              </div>
            </div>
          </div>

          {/* Time Pill */}
          <div className="absolute top-[55%] right-[5%]" style={{ animation: "crx-float2 7s ease-in-out infinite" }}>
            <div className="bg-[#F5D547] rounded-full px-4 py-2 shadow-[0_4px_16px_rgba(245,213,71,0.4)] flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" strokeWidth="2.5"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span className="text-[13px] font-semibold text-[#1A1A1A]">02:35</span>
              <span className="text-[11px] text-black/50">Work Time</span>
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

      {forgotOpen && <ForgotPasswordModal onClose={() => setForgotOpen(false)} />}
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
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, app: "hr" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Something went wrong");
      setSent(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl p-7 w-full max-w-sm relative shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-[#B0B0B0] hover:text-[#1A1A1A] text-lg leading-none"
        >
          ×
        </button>
        <h2 className="font-serif text-[22px] text-[#1A1A1A] mb-1">Forgot password?</h2>
        {sent ? (
          <p className="text-sm text-[#555] mt-3">
            If that email is registered, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 mt-3">
            <p className="text-sm text-[#7A7A7A]">Enter your account email and we'll send a reset link.</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@digitalsukoon.com"
              className="w-full px-4 py-3 border-[1.5px] border-[#E8E0D0] rounded-[10px] text-sm text-[#1A1A1A] bg-white/80 placeholder:text-[#B0B0B0] focus:outline-none focus:border-[#F5D547] focus:shadow-[0_0_0_3px_rgba(245,213,71,0.15)] transition-all"
            />
            {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-full bg-[#F5D547] text-[#1A1A1A] text-sm font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] disabled:opacity-50 transition-all"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
