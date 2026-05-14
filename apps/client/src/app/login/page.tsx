"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { Eye, EyeOff, Mail, Lock, AlertTriangle } from "lucide-react";

export default function ClientLoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center relative overflow-hidden"
      style={{
        background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)",
        fontFamily: "'Instagram Sans', system-ui, sans-serif",
      }}
    >
      {/* Background gradient orbs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full opacity-30" style={{ background: "radial-gradient(circle, #F5D547 0%, transparent 70%)" }} />
      <div className="absolute bottom-[-15%] right-[-5%] w-[400px] h-[400px] rounded-full opacity-20" style={{ background: "radial-gradient(circle, #E8D5B7 0%, transparent 70%)" }} />
      <div className="absolute top-[40%] right-[20%] w-[250px] h-[250px] rounded-full opacity-15" style={{ background: "radial-gradient(circle, #F5D547 0%, transparent 70%)" }} />

      {/* Card */}
      <div
        className="relative z-10 w-full max-w-[420px] mx-4"
        style={{ animation: mounted ? "crx-fadeInUp 0.6s ease-out" : "none" }}
      >
        {/* Brand header */}
        <div className="text-center mb-8" style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.1s both" : "none" }}>
          <div className="flex items-center justify-center gap-2.5 mb-4">
            <img src="/logo.svg" alt="Digital Sukoon" className="h-10 w-10 rounded-full shadow-[0_2px_12px_rgba(0,0,0,0.1)]" />
            <span className="font-bold text-[#1A1A1A] uppercase tracking-[2px] text-sm">Digital Sukoon</span>
          </div>
          <h1 className="font-serif text-[36px] font-normal text-[#1A1A1A] leading-tight">
            Welcome back
          </h1>
          <p className="text-sm text-[#7A7A7A] mt-1.5 tracking-wide uppercase text-[11px] font-medium">
            Client Portal
          </p>
        </div>

        {/* Glass-morphism form card */}
        <div
          className="crx-glass rounded-3xl p-7 sm:p-8"
          style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.25s both" : "none" }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email</label>
              <div className="relative">
                <Mail className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors duration-300 ${focusedField === "email" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  required
                  onFocus={() => setFocusedField("email")}
                  onBlur={() => setFocusedField(null)}
                  className={`w-full pl-11 pr-4 py-3.5 rounded-xl text-sm outline-none transition-all duration-300 ${
                    focusedField === "email"
                      ? "bg-white border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
                      : "bg-white/60 border-[1.5px] border-[#E8E0D0]"
                  } text-[#1A1A1A] placeholder:text-[#B0B0B0]`}
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Password</label>
              <div className="relative">
                <Lock className={`absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 transition-colors duration-300 ${focusedField === "password" ? "text-[#F5D547]" : "text-[#B0B0B0]"}`} />
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  onFocus={() => setFocusedField("password")}
                  onBlur={() => setFocusedField(null)}
                  className={`w-full pl-11 pr-12 py-3.5 rounded-xl text-sm outline-none transition-all duration-300 ${
                    focusedField === "password"
                      ? "bg-white border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
                      : "bg-white/60 border-[1.5px] border-[#E8E0D0]"
                  } text-[#1A1A1A] placeholder:text-[#B0B0B0]`}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#F5D547] transition-colors"
                >
                  {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 border border-red-100">
                <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0 transition-all duration-300"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 border-2 border-[#1A1A1A]/20 border-t-[#1A1A1A] rounded-full animate-spin" />
                  Signing in...
                </span>
              ) : (
                "Sign In"
              )}
            </button>

            <p className="text-sm text-[#B0B0B0] text-center pt-1">
              Have an invite?{" "}
              <Link href="/signup" className="text-[#7A7A7A] underline underline-offset-2 hover:text-[#1A1A1A] transition-colors">
                Set up your account
              </Link>
            </p>
          </form>
        </div>

        {/* Footer */}
        <p
          className="text-center text-xs text-[#B0B0B0] mt-6"
          style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.4s both" : "none" }}
        >
          Powered by Digital Sukoon
        </p>
      </div>
    </div>
  );
}
