"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, Lock, User, Check, AlertCircle, ArrowRight, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { AuthField, AuthStyles } from "@/components/auth/shared";

const pwScore = (v: string) => {
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
  return s;
};
const pwLabel = ["", "Weak", "Fair", "Good", "Strong"];

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBlurred, setPwBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const segRef = useRef<HTMLDivElement>(null);

  const score = pwScore(password);
  const pwErr = pwBlurred && password && score < 2 ? "Make it harder to guess" : null;

  // Position segmented pill under "I have an invite" (right side)
  useEffect(() => {
    if (!segRef.current) return;
    const w = segRef.current.querySelector('[data-tab="signup"]') as HTMLElement | null;
    const pill = segRef.current.querySelector(".seg-pill") as HTMLElement | null;
    if (w && pill) {
      pill.style.width = w.offsetWidth + "px";
      pill.style.transform = `translateX(${w.offsetLeft - 4}px)`;
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (score < 2) { setError("Make it harder to guess — try a longer, mixed password."); return; }
    setSubmitState("loading");
    try {
      const res = await apiFetch<{ accessToken: string; refreshToken: string; user: any }>(
        "/client/auth/register",
        {
          method: "POST",
          body: JSON.stringify({ token, password, ...(name.trim() ? { contactName: name.trim() } : {}) }),
        }
      );
      const data = (res as any).data ?? res;
      localStorage.setItem("clientAccessToken", data.accessToken);
      localStorage.setItem("clientRefreshToken", data.refreshToken);
      localStorage.setItem("clientUser", JSON.stringify(data.user));
      setSubmitState("success");
      setTimeout(() => router.push("/dashboard"), 600);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
      setSubmitState("idle");
    }
  }

  return (
    <main className="auth-page min-h-screen w-full bg-bg relative overflow-x-hidden text-ink">
      <div className="fixed inset-0 cream-mesh pointer-events-none" aria-hidden />
      <div className="fixed inset-0 dots-bg pointer-events-none opacity-50" aria-hidden />
      <div className="grain" aria-hidden />

      <header className="relative z-20 max-w-[1340px] mx-auto px-6 lg:px-10 pt-6 flex items-center justify-between auth-fade-up d1">
        <Link href="/" className="flex items-center gap-3">
          <Mark size={34} />
          <div className="leading-tight">
            <p className="text-[13.5px] font-bold text-ink">Digital Sukoon</p>
            <p className="text-[11px] text-ink-3 font-medium font-mono-auth uppercase tracking-[0.16em] -mt-0.5">
              Client review room
            </p>
          </div>
        </Link>
        <Link
          href="/login"
          className="text-[12.5px] font-bold text-ink-2 hover:text-ink"
        >
          ← Back to sign in
        </Link>
      </header>

      <section className="relative z-10 max-w-[640px] mx-auto px-6 pt-12 lg:pt-16 pb-8 text-center">
        <div
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border-2 border-ink text-[11px] font-bold text-ink-2 auth-fade-up d2"
          style={{ boxShadow: "2px 2px 0 #F5D547" }}
        >
          <span className="ripple-dot" aria-hidden />
          <span className="font-mono-auth uppercase tracking-[0.18em]">You're invited</span>
        </div>

        <h1 className="mt-6" style={{ fontSize: "clamp(48px,7vw,96px)", lineHeight: "0.94" }}>
          <span className="display-fraunces text-ink auth-fade-up d3">Hello, </span>
          <span className="display-instr text-ink auth-fade-up d3">friend.</span>
        </h1>

        <p className="mt-6 text-ink-3 text-[16px] lg:text-[18px] font-medium leading-snug auth-fade-up d4 max-w-[480px] mx-auto">
          We'll have your room ready in a moment — just choose a password and we'll take it from there.
        </p>
      </section>

      <section className="relative z-10 max-w-[480px] mx-auto px-6 pb-20">
        <div className="v3-card-action p-6 sm:p-7 auth-pop-in d5 relative">
          <div
            className="absolute -top-3 -right-3 w-16 h-16 rounded-full bg-action border-2 border-ink grid place-items-center font-instr italic text-[15px] font-medium text-ink leading-none"
            style={{ transform: "rotate(8deg)", boxShadow: "2px 2px 0 #1A1A1A", animation: "auth-stampDrop .9s cubic-bezier(0.34,1.45,0.64,1) .6s both" }}
            aria-hidden
          >
            hello.
          </div>

          {!token ? (
            <InvalidInvite />
          ) : (
            <>
              <div className="mb-5">
                <h2 className="font-display text-[24px] font-semibold text-ink leading-tight">Open your review room.</h2>
                <p className="font-instr italic text-ink-3 text-[16px] mt-1 leading-snug">
                  Just a couple of details and we'll take it from there.
                </p>
              </div>

              <div ref={segRef} className="seg mb-5" role="tablist" aria-label="Auth options">
                <span className="seg-pill" style={{ width: "50%" }} aria-hidden />
                <Link
                  href="/login"
                  data-tab="signin"
                  role="tab"
                  aria-selected={false}
                  className="seg-btn"
                >
                  Sign in
                </Link>
                <button
                  type="button"
                  data-tab="signup"
                  role="tab"
                  aria-selected={true}
                  className="seg-btn active"
                >
                  I have an invite
                </button>
              </div>

              <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
                <div className="auth-fade-up">
                  <AuthField
                    id="cname"
                    label="Your name"
                    icon={<User size={16} />}
                    value={name}
                    onChange={setName}
                    error={null}
                    autoComplete="name"
                    hint="Optional — what should we call you?"
                  />
                </div>

                <div className="auth-fade-up" style={{ animationDelay: ".04s" }}>
                  <AuthField
                    id="cpw"
                    label="Choose a password"
                    type="password"
                    icon={<Lock size={16} />}
                    value={password}
                    onChange={(v) => { setPassword(v); if (error) setError(""); }}
                    onBlur={() => setPwBlurred(true)}
                    error={pwErr}
                    autoComplete="new-password"
                    showPass={showPass}
                    onToggleShowPass={() => setShowPass((s) => !s)}
                  />
                  {password && (
                    <div className="mt-2 ml-1 auth-fade-up">
                      <div className="meter">
                        {[1, 2, 3, 4].map((i) => (
                          <div key={i} className={`meter-seg ${score >= i ? `on-${score}` : ""}`} />
                        ))}
                      </div>
                      <p className="text-[11px] mt-1.5 font-display italic">
                        <span className={["text-ink-4", "text-danger", "text-attention", "text-action-deep", "text-success"][score]}>
                          {pwLabel[score] || "—"}
                        </span>
                        <span className="text-ink-4 not-italic font-sans"> · {password.length} chars</span>
                      </p>
                    </div>
                  )}
                </div>

                <div className="auth-fade-up" style={{ animationDelay: ".08s" }}>
                  <AuthField
                    id="cpw2"
                    label="Confirm password"
                    type="password"
                    icon={<Lock size={16} />}
                    value={confirmPassword}
                    onChange={(v) => { setConfirmPassword(v); if (error) setError(""); }}
                    error={null}
                    autoComplete="new-password"
                    showPass={showConfirm}
                    onToggleShowPass={() => setShowConfirm((s) => !s)}
                  />
                </div>

                {error && (
                  <div role="alert" className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-danger-bg border border-danger/30 auth-fade-up">
                    <AlertCircle size={14} className="text-danger shrink-0" />
                    <span className="text-[12.5px] text-danger font-semibold">{error}</span>
                  </div>
                )}

                <div className="pt-1 auth-fade-up" style={{ animationDelay: ".16s" }}>
                  <button
                    type="submit"
                    disabled={submitState !== "idle"}
                    className="btn-3d-y w-full flex items-center justify-center gap-2 px-5 py-3.5 rounded-full bg-ink text-white font-bold text-[14px] tracking-tight border-2 border-ink disabled:opacity-70 disabled:cursor-not-allowed"
                    aria-live="polite"
                  >
                    {submitState === "idle"    && (<><span>Create my review room</span><ArrowRight size={16} /></>)}
                    {submitState === "loading" && (<><span className="auth-spinner" aria-hidden /><span>Setting things up…</span></>)}
                    {submitState === "success" && (<><Check size={20} color="#F5D547" strokeWidth={3} /><span>Welcome aboard</span></>)}
                  </button>
                </div>
              </form>

              <p className="text-center text-[11px] text-ink-4 mt-5 font-instr italic leading-snug">
                By creating your account you accept our{" "}
                <a href="#" className="underline hover:text-ink not-italic">terms</a> &amp;{" "}
                <a href="#" className="underline hover:text-ink not-italic">privacy notice</a>.
              </p>
            </>
          )}
        </div>
      </section>

      <footer
        className="relative z-10 max-w-[1340px] mx-auto px-6 lg:px-10 pb-10 pt-6"
        style={{ borderTop: "1.5px dashed rgba(26,26,26,.15)" }}
      >
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="flex items-center gap-3">
            <Mark size={28} />
            <p className="font-mono-auth text-[10.5px] uppercase tracking-[0.18em] text-ink-3 font-bold">
              © {new Date().getFullYear()} Digital Sukoon · A small studio · Mumbai &amp; Lisbon
            </p>
          </div>
          <div className="flex gap-6 text-[12px] font-bold text-ink-3">
            <a href="#" className="hover:text-indigo">Terms</a>
            <a href="#" className="hover:text-indigo">Privacy</a>
            <a href="mailto:hello@digitalsukoon.com" className="hover:text-indigo">Contact</a>
          </div>
        </div>
      </footer>

      <AuthStyles />
    </main>
  );
}

function InvalidInvite() {
  return (
    <div className="text-center space-y-4 py-6">
      <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center mx-auto border-2 border-ink">
        <AlertTriangle size={20} className="text-ink-3" />
      </div>
      <h2 className="font-display text-[22px] font-semibold text-ink">Invalid invite link</h2>
      <p className="text-[13px] text-ink-3 font-medium max-w-[300px] mx-auto leading-relaxed">
        This invite is missing or invalid. Ask your account manager at Digital Sukoon for a new one.
      </p>
      <Link
        href="/login"
        className="inline-block text-[13px] text-ink font-semibold underline underline-offset-4 decoration-ink-4 hover:decoration-ink"
      >
        Back to sign in
      </Link>
    </div>
  );
}

function Mark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="rounded-xl bg-ink text-white grid place-items-center font-black tracking-widest flex-shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      DS
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
