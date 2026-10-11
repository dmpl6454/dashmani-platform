"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { safeNext, nextQueryFor } from "@/lib/safe-next";
import { AuthField, AuthShell, AuthTabs } from "@/components/auth/shared";
import { GoogleSignIn } from "@/components/auth/google-signin";
import { useHydrated } from "@/lib/hooks/use-hydrated";

// Two modes on one route (the route shape is unchanged, see CLAUDE.md):
//   /signup?token=<uuid>  → accept an admin invite (password only; the email is the invite's)
//   /signup               → public self-signup, where the website's "Start a campaign" lands
// Both store the same token keys as /login and then honour a same-site ?next=.

const pwScore = (v: string) => {
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) s++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
  return s;
};
const pwLabel = ["", "Weak", "Fair", "Good", "Strong"];
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function storeSession(data: { accessToken: string; refreshToken: string; user: unknown }) {
  localStorage.setItem("clientAccessToken", data.accessToken);
  localStorage.setItem("clientRefreshToken", data.refreshToken);
  localStorage.setItem("clientUser", JSON.stringify(data.user));
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const invited = Boolean(token);
  const bookingIntent = (searchParams.get("next") ?? "").startsWith("/campaigns");

  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [password, setPassword] = useState("");
  const [pwBlurred, setPwBlurred] = useState(false);
  const [showPass, setShowPass] = useState(false);
  // While Google's "one more thing" company step is open, the password form steps aside.
  const [googleStep, setGoogleStep] = useState(false);
  // Leaving the Google company step ("Use email instead") re-mounts the form: put focus back on its
  // first field (only on that true → false edge — the step also reports false on mount).
  const prevGoogleStep = useRef(false);
  useEffect(() => {
    if (prevGoogleStep.current && !googleStep) document.getElementById(invited ? "cname" : "ccompany")?.focus();
    prevGoogleStep.current = googleStep;
  }, [googleStep, invited]);
  const [error, setError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "success">("idle");
  const hydrated = useHydrated();

  // Already signed in (Back from the booking steps, or a refresh after signing up):
  // go on instead of showing the sign-up form again. Invite links are left alone.
  useEffect(() => {
    if (invited) return;
    try {
      if (localStorage.getItem("clientAccessToken") && localStorage.getItem("clientUser")) {
        router.replace(safeNext() ?? "/dashboard");
      }
    } catch { /* storage blocked: just show the form */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const score = pwScore(password);
  const pwErr = pwBlurred && password && score < 2 ? "Make it harder to guess" : null;
  const emailErr = emailBlurred && email && !emailOk(email) ? "Please enter a valid email" : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!invited) {
      if (company.trim().length < 2) { setError("Tell us your company or brand name."); return; }
      if (name.trim().length < 2) { setError("Tell us your name."); return; }
      if (!emailOk(email)) { setEmailBlurred(true); setError("Please enter a valid email."); return; }
    }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (score < 2) { setError("Make it harder to guess — try a longer, mixed password."); return; }
    setSubmitState("loading");
    try {
      const res = invited
        ? await apiFetch<{ accessToken: string; refreshToken: string; user: unknown }>("/client/auth/register", {
            method: "POST",
            body: JSON.stringify({ token, password, ...(name.trim() ? { contactName: name.trim() } : {}) }),
          })
        : await apiFetch<{ accessToken: string; refreshToken: string; user: unknown }>("/client/auth/signup", {
            method: "POST",
            body: JSON.stringify({
              companyName: company.trim(),
              contactName: name.trim(),
              email: email.trim(),
              password,
              ...(phone.trim() ? { phone: phone.trim() } : {}),
            }),
          });
      const data = (res as any).data ?? res;
      storeSession(data);
      setSubmitState("success");
      // replace, not push: Back from the next page must not return to this form.
      setTimeout(() => router.replace(safeNext() ?? "/dashboard"), 600);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
      setSubmitState("idle");
    }
  }

  const nextParam = searchParams.get("next");
  const signInHref = `/login${nextQueryFor(nextParam)}`;
  const signUpHref = `/signup${nextQueryFor(nextParam)}`;

  return (
    <AuthShell
      kicker={invited ? "CH 07 · You're invited" : bookingIntent ? "CH 07 · Start a campaign" : "CH 07 · Create your account"}
      title={bookingIntent ? <>Book the <em>network.</em></> : <>Start <em>here.</em></>}
      lines={
        invited
          ? [<>Your account is ready. Choose a password and we will take you straight in.</>]
          : [
              <>Pick the pages, upload your video or image, add the caption. Our team reviews it, posts it, and sends you every link.</>,
              <>Free to create. No card needed to get started.</>,
              <>Already a client? <Link href={signInHref}>Sign in</Link>.</>,
            ]
      }
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>{invited ? "Open your account." : "Create your account."}</h2>
          <p>{invited ? "Just a password, and a name if you like." : "Takes under a minute."}</p>
        </div>

        {!googleStep && (
          <AuthTabs active="signup" signInHref={signInHref} signUpHref={signUpHref} signUpLabel={invited ? "I have an invite" : "Create account"} />
        )}

        {/* Not the hidden attribute: .auth-form's display:flex would override it. */}
        {!googleStep && (
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            {!invited && (
              <div className="auth-fields">
                <div className="full">
                  <AuthField id="ccompany" label="Company or brand" autoComplete="organization" placeholder="Acme Studios"
                    value={company} onChange={(v) => { setCompany(v); if (error) setError(""); }} error={null} />
                </div>
                <div className="full">
                  <AuthField id="cemail" label="Work email" type="email" inputMode="email" autoComplete="email" placeholder="you@company.com"
                    value={email} onChange={(v) => { setEmail(v); if (error) setError(""); }} onBlur={() => setEmailBlurred(true)} error={emailErr} />
                </div>
              </div>
            )}

            <div className="auth-fields">
              <AuthField id="cname" label="Your name" autoComplete="name" placeholder="Full name"
                value={name} onChange={(v) => { setName(v); if (error) setError(""); }} error={null}
                hint={invited ? "Optional — what should we call you?" : undefined} />
              {!invited && (
                <AuthField id="cphone" label="Phone (optional)" type="tel" inputMode="tel" autoComplete="tel" placeholder="+91"
                  value={phone} onChange={setPhone} error={null} />
              )}
            </div>

            <div>
              <AuthField id="cpw" label="Choose a password" type="password" autoComplete="new-password" placeholder="At least 8 characters"
                value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} onBlur={() => setPwBlurred(true)} error={pwErr}
                hint="At least 8 characters — tap the eye to check it"
                showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
              {password && (
                <div className="mt-2">
                  <div className="auth-meter" aria-hidden>
                    {[1, 2, 3, 4].map((i) => <span key={i} className={score >= i ? `on-${score}` : ""} />)}
                  </div>
                  <div className="auth-meter-label">
                    <span>{pwLabel[score] || "—"}</span>
                    <span>{password.length} chars</span>
                  </div>
                </div>
              )}
            </div>

            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}

            <button type="submit" disabled={submitState !== "idle" || !hydrated} className="auth-btn" aria-live="polite">
              {submitState === "idle" && (
                <>
                  <span>{invited ? "Open my account" : bookingIntent ? "Create account & start a campaign" : "Create my account"}</span>
                  <ArrowRight size={17} />
                </>
              )}
              {submitState === "loading" && (<><span className="auth-spinner" aria-hidden /><span>Setting things up…</span></>)}
              {submitState === "success" && (<><Check size={18} strokeWidth={3} /><span>Welcome aboard</span></>)}
            </button>

            <p className="auth-fine">
              By creating an account you agree to work with Digital Sukoon under its standard terms. Questions: <a href="mailto:hello@digitalsukoon.com">hello@digitalsukoon.com</a>.
            </p>
          </form>
        )}

        {/* Invite acceptance is tied to the invite's email and password, so Google is offered on public signup only. */}
        {!invited && (
          <GoogleSignIn
            mode="signup"
            initialCompany={company}
            onProfileStep={setGoogleStep}
            onSession={(s) => { storeSession(s); setSubmitState("success"); setTimeout(() => router.replace(safeNext() ?? "/dashboard"), 300); }}
          />
        )}
      </div>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
