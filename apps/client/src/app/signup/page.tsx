"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [contactName, setContactName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    setLoading(true);
    setError("");
    try {
      const res: any = await apiFetch("/client/auth/register", {
        method: "POST",
        body: JSON.stringify({ token, password, ...(contactName.trim() ? { contactName: contactName.trim() } : {}) }),
      });
      localStorage.setItem("clientAccessToken", res.data.accessToken);
      localStorage.setItem("clientRefreshToken", res.data.refreshToken);
      localStorage.setItem("clientUser", JSON.stringify(res.data.user));
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const EyeIcon = ({ show }: { show: boolean }) => show ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );

  const inputClass = "w-full h-11 px-4 bg-bg rounded-xl text-[14px] text-ink font-medium placeholder:text-ink-4 outline-none transition-all";
  const inputStyle = { border: "2px solid rgba(26,26,26,0.18)" };
  const focusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "#5D5FEF"; e.currentTarget.style.boxShadow = "0 0 0 3px rgba(93,95,239,0.12)"; },
    onBlur:  (e: React.FocusEvent<HTMLInputElement>) => { e.currentTarget.style.borderColor = "rgba(26,26,26,0.18)"; e.currentTarget.style.boxShadow = "none"; },
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-[400px] fade-up d1">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 rounded-2xl bg-ink text-white items-center justify-center font-display text-[20px] font-semibold mb-4 pop-in">
            DS
          </div>
          <h1 className="font-display text-[32px] font-semibold text-ink leading-tight">Set up your account</h1>
          <p className="text-[13px] text-ink-3 font-medium mt-1 uppercase tracking-widest">Client Portal</p>
        </div>

        {/* Card */}
        <div className="v3-card p-7 fade-up d2">
          {!token ? (
            <div className="text-center space-y-4 py-4">
              <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center mx-auto">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-3">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <h2 className="text-ink font-bold text-[15px]">Invalid invite link</h2>
              <p className="text-[13px] text-ink-3 font-medium">
                This invite link is missing or invalid. Please ask your account manager for a new invite.
              </p>
              <Link href="/login" className="inline-block text-[13px] text-indigo font-semibold hover:underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">

              {/* Name (optional) */}
              <div>
                <label className="block text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-1.5">
                  Your name <span className="text-ink-4 normal-case tracking-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Jane Smith"
                  className={inputClass}
                  style={inputStyle}
                  {...focusHandlers}
                />
              </div>

              {/* Password */}
              <div>
                <label className="block text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-1.5">Password</label>
                <div className="relative">
                  <input
                    type={showPass ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    required
                    minLength={8}
                    className={`${inputClass} pr-11`}
                    style={inputStyle}
                    {...focusHandlers}
                  />
                  <button type="button" onClick={() => setShowPass(!showPass)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors">
                    <EyeIcon show={showPass} />
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div>
                <label className="block text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-1.5">Confirm password</label>
                <div className="relative">
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter your password"
                    required
                    className={`${inputClass} pr-11`}
                    style={inputStyle}
                    {...focusHandlers}
                  />
                  <button type="button" onClick={() => setShowConfirm(!showConfirm)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors">
                    <EyeIcon show={showConfirm} />
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-danger-bg" style={{ border: "1.5px solid rgba(184,55,40,0.2)" }}>
                  <span className="text-danger shrink-0">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </span>
                  <span className="text-[13px] text-danger font-semibold">{error}</span>
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-xl bg-ink text-white text-[14px] font-bold border-2 border-ink btn-3d transition-all disabled:opacity-50 mt-2"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Creating account…
                  </span>
                ) : "Create account"}
              </button>

              <p className="text-[13px] text-ink-3 text-center font-medium pt-1">
                Already have an account?{" "}
                <Link href="/login" className="text-indigo font-semibold hover:underline">Sign in</Link>
              </p>
            </form>
          )}
        </div>

        <p className="text-center text-[11.5px] text-ink-4 font-medium mt-6">Powered by Digital Sukoon</p>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
