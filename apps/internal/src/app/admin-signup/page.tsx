"use client";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { Eye, EyeOff, Lock, User } from "lucide-react";

function AdminSignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: "", password: "", confirmPassword: "" });
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!token) { setTokenValid(false); return; }
    apiFetch<any>(`/admin/users/invite/${token}`)
      .then((res) => { setTokenValid(true); setInviteEmail(res.data.email); })
      .catch(() => setTokenValid(false));
  }, [token]);

  const inputWrapperClass = (field: string) =>
    `relative flex items-center w-full rounded-xl transition-all duration-300 ${
      focusedField === field
        ? "bg-[#FFFEF8] border-[1.5px] border-[#F5D547] shadow-[0_0_0_3px_rgba(245,213,71,0.15)]"
        : "bg-[#FFF8E1]/60 border-[1.5px] border-[#F0EAD8] hover:border-[#E8D8B4]"
    }`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      setShake(true);
      setTimeout(() => setShake(false), 500);
      return;
    }
    setLoading(true);
    try {
      const res: any = await apiFetch<any>("/admin/users/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token, name: form.name, password: form.password }),
      });
      localStorage.setItem("accessToken", res.data.accessToken);
      localStorage.setItem("refreshToken", res.data.refreshToken);
      localStorage.setItem("user", JSON.stringify(res.data.user));
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Signup failed");
      setShake(true);
      setTimeout(() => setShake(false), 500);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex overflow-hidden" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 50%, #EFE2C4 100%)", fontFamily: "'Instagram Sans', system-ui, sans-serif" }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[10%] left-[15%] w-[400px] h-[400px] rounded-full opacity-[0.08]" style={{ background: "radial-gradient(circle, #F5D547 0%, transparent 70%)", animation: "crx-float1 12s ease-in-out infinite" }} />
        <div className="absolute bottom-[15%] right-[10%] w-[300px] h-[300px] rounded-full opacity-[0.06]" style={{ background: "radial-gradient(circle, #B8956A 0%, transparent 70%)", animation: "crx-float2 10s ease-in-out infinite" }} />
      </div>

      <div className="w-full lg:w-[44%] min-w-0 lg:min-w-[380px] flex flex-col justify-between p-6 sm:p-9 relative z-10" style={{ animation: mounted ? "crx-fadeInLeft 0.6s ease-out" : "none" }}>
        <div className="flex items-center gap-2.5">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <span className="font-bold text-[#1A1A1A] uppercase tracking-[2px] text-sm">Digital Sukoon</span>
        </div>

        <div className="max-w-[380px] w-full mx-auto">
          <div className="text-center mb-8" style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.15s both" : "none" }}>
            <h1 className="font-serif text-[36px] font-normal text-[#1A1A1A] leading-tight">Complete Signup</h1>
            <p className="text-sm text-[#7A7A7A] mt-2">Set up your admin account</p>
          </div>

          <div className={`bg-white/60 backdrop-blur-xl rounded-2xl border border-white/50 shadow-[0_8px_40px_rgba(0,0,0,0.06)] p-7 ${shake ? "animate-[shake_0.5s_ease-in-out]" : ""}`} style={{ animation: mounted ? "crx-fadeInUp 0.5s ease-out 0.3s both" : "none" }}>
            {tokenValid === null && (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
              </div>
            )}

            {tokenValid === false && (
              <div className="text-center py-6 space-y-3">
                <div className="text-4xl">🔗</div>
                <p className="text-[#1A1A1A] font-medium">Invalid or expired invite link</p>
                <p className="text-sm text-[#7A7A7A]">Please ask a Super Admin to resend your invite.</p>
                <a href="/login" className="inline-block mt-2 text-sm text-[#B8956A] hover:underline">Back to login</a>
              </div>
            )}

            {tokenValid === true && (
              <form onSubmit={handleSubmit} className="space-y-5">
                {inviteEmail && (
                  <div className="bg-[#FFF8E1]/80 border border-[#F0EAD8] rounded-xl px-4 py-2.5 text-sm text-[#7A7A7A]">
                    Signing up as <span className="font-medium text-[#1A1A1A]">{inviteEmail}</span>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Your Full Name</label>
                  <div className={inputWrapperClass("name")}>
                    <User className="h-4 w-4 text-[#B0B0B0] ml-3.5 shrink-0" />
                    <input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" onFocus={() => setFocusedField("name")} onBlur={() => setFocusedField(null)} className="w-full bg-transparent px-3 py-3.5 text-sm outline-none text-[#1A1A1A] placeholder:text-[#B0B0B0]" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Password</label>
                  <div className={inputWrapperClass("password")}>
                    <Lock className="h-4 w-4 text-[#B0B0B0] ml-3.5 shrink-0" />
                    <input type={showPass ? "text" : "password"} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min. 8 characters" onFocus={() => setFocusedField("password")} onBlur={() => setFocusedField(null)} className="w-full bg-transparent px-3 py-3.5 text-sm outline-none text-[#1A1A1A] placeholder:text-[#B0B0B0]" />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="pr-3.5 text-[#B0B0B0] hover:text-[#F5D547] transition-colors shrink-0">
                      {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Confirm Password</label>
                  <div className={inputWrapperClass("confirm")}>
                    <Lock className="h-4 w-4 text-[#B0B0B0] ml-3.5 shrink-0" />
                    <input type={showConfirm ? "text" : "password"} required value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} placeholder="Re-enter password" onFocus={() => setFocusedField("confirm")} onBlur={() => setFocusedField(null)} className="w-full bg-transparent px-3 py-3.5 text-sm outline-none text-[#1A1A1A] placeholder:text-[#B0B0B0]" />
                    <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="pr-3.5 text-[#B0B0B0] hover:text-[#F5D547] transition-colors shrink-0">
                      {showConfirm ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-sm text-[#E74C3C] bg-red-50/60 border border-red-100 rounded-lg px-3 py-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    {error}
                  </div>
                )}

                <button type="submit" disabled={loading} className="group w-full py-3.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[15px] font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_8px_32px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all duration-300 flex items-center justify-center gap-2">
                  {loading ? (
                    <><svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Creating account...</>
                  ) : "Create My Account"}
                </button>
              </form>
            )}
          </div>
        </div>
        <div />
      </div>

      <div className="hidden lg:block flex-1 relative overflow-hidden" style={{ borderRadius: "24px 0 0 24px" }}>
        <div className="absolute inset-0" style={{ background: "linear-gradient(135deg, #C4A882 0%, #A08060 40%, #8B7355 100%)" }} />
        <div className="absolute inset-0" style={{ background: "radial-gradient(circle at 30% 40%, rgba(245,213,71,0.15) 0%, transparent 50%)" }} />
        <div className="relative w-full h-full min-h-screen flex items-center justify-center">
          <div className="text-center text-white/80 space-y-3">
            <div className="text-6xl font-light font-serif">Welcome</div>
            <div className="text-lg opacity-60">to the Management Portal</div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes shake { 0%, 100% { transform: translateX(0); } 10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); } 20%, 40%, 60%, 80% { transform: translateX(4px); } }
      `}</style>
    </div>
  );
}

export default function AdminSignupPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 40%, #EFE2C4 100%)" }}><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>}>
      <AdminSignupForm />
    </Suspense>
  );
}
