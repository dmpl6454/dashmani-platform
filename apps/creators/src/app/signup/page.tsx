"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight, Check } from "lucide-react";
import { creatorSignupSchema } from "@dashmani/shared/src/validators/creator";
import { useAuth } from "@/lib/auth";
import { apiFetch, ApiError, hasSession } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { nextQueryFor, safeNext } from "@/lib/safe-next";
import { useHydrated } from "@/lib/use-hydrated";
import type { CreatorSession } from "@/lib/types";
import {
  AuthCheck, AuthCountry, AuthFallback, AuthField, AuthShell, AuthTabs, PasswordMeter,
} from "@/components/auth/shared";
import { GoogleSignIn } from "@/components/auth/google-signin";

// Creator sign-up: POST /v1/creator/auth/signup with the shared creatorSignupSchema (the API
// validates the same schema), then straight into the account — the verification email is sent
// by the API and the dashboard's checklist asks for it. Google sign-up runs its own profile step.

type Field = "name" | "email" | "password" | "country" | "acceptTerms" | "confirmAdult";

function SignupForm() {
  const router = useRouter();
  const { adoptSession } = useAuth();
  const nextParam = useSearchParams().get("next");
  const hydrated = useHydrated();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [country, setCountry] = useState("");
  const [terms, setTerms] = useState(false);
  const [adult, setAdult] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success">("idle");
  const [googleStep, setGoogleStep] = useState(false);

  // Leaving Google's profile step re-mounts the form: put focus back on its first field.
  const prevGoogleStep = useRef(false);
  useEffect(() => {
    if (prevGoogleStep.current && !googleStep) document.getElementById("sname")?.focus();
    prevGoogleStep.current = googleStep;
  }, [googleStep]);

  useEffect(() => {
    if (hasSession()) router.replace(safeNext() ?? "/dashboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = (f: Field) => {
    if (errors[f]) setErrors((e) => ({ ...e, [f]: undefined }));
    if (error) setError("");
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (state !== "idle") return;
    setError("");
    const parsed = creatorSignupSchema.safeParse({
      name, email, password, country, acceptTerms: terms, confirmAdult: adult,
    });
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const f = issue.path[0] as Field;
        if (!next[f]) next[f] = issue.message;
      }
      setErrors(next);
      const first = (["name", "email", "password", "country", "acceptTerms", "confirmAdult"] as Field[]).find((f) => next[f]);
      const ids: Record<Field, string> = { name: "sname", email: "semail", password: "spw", country: "scountry", acceptTerms: "sterms", confirmAdult: "sadult" };
      if (first) document.getElementById(ids[first])?.focus();
      return;
    }
    setErrors({});
    setState("loading");
    try {
      const res = await apiFetch<CreatorSession>("/creator/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
          ...(country ? { country } : {}),
          acceptTerms: true,
          confirmAdult: true,
        }),
      });
      setState("success");
      adoptSession(res.data);
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_EXISTS") {
        setErrors({ email: "There's already an account with this email." });
        setError(
          "There's already an account with this email — sign in instead, or use Forgot password on the sign-in page. If you closed your account, email creators@digitalsukoon.com to reopen it.",
        );
      } else if (err instanceof ApiError && err.details?.length) {
        const next: Partial<Record<Field, string>> = {};
        for (const d of err.details) {
          const f = d.field?.split(".")[0] as Field | undefined;
          if (f && !next[f]) next[f] = d.message;
        }
        setErrors(next);
        setError(errorSentence(err));
      } else {
        setError(errorSentence(err));
      }
      setState("idle");
    }
  }

  const signInHref = `/login${nextQueryFor(nextParam)}`;
  const signUpHref = `/signup${nextQueryFor(nextParam)}`;

  return (
    <AuthShell
      kicker="Creator portal · Join"
      title={<>Get <em>booked.</em></>}
      lines={[
        <>Brands and agencies will book promotion on your page through Digital Sukoon. You name your asking price and see your payout before you accept.</>,
        <>Nothing is posted without your approval, and you can disconnect at any time.</>,
        <>Already a creator? <Link href={signInHref}>Sign in</Link>.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>Create your creator account.</h2>
          <p>Takes a minute. Next you&apos;ll connect your Facebook Page or Instagram professional account.</p>
        </div>

        {!googleStep && <AuthTabs active="signup" signInHref={signInHref} signUpHref={signUpHref} />}

        {/* Not the hidden attribute: .auth-form's display:flex would override it. */}
        {!googleStep && (
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <AuthField id="sname" label="Your name" autoComplete="name" placeholder="Full name"
              value={name} onChange={(v) => { setName(v); clear("name"); }} error={errors.name ?? null} />
            <AuthField id="semail" label="Email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com"
              value={email} onChange={(v) => { setEmail(v); clear("email"); }} error={errors.email ?? null} />
            <div>
              <AuthField id="spw" label="Choose a password" type="password" autoComplete="new-password" placeholder="At least 8 characters"
                value={password} onChange={(v) => { setPassword(v); clear("password"); }} error={errors.password ?? null}
                hint="At least 8 characters — tap the eye to check it"
                showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
              <PasswordMeter password={password} />
            </div>
            <AuthCountry id="scountry" value={country} onChange={(v) => { setCountry(v); clear("country"); }} error={errors.country ?? null} />

            <AuthCheck id="sterms" checked={terms} onChange={(v) => { setTerms(v); clear("acceptTerms"); }} error={errors.acceptTerms ?? null}>
              I agree to the <Link href="/terms" target="_blank">creator terms</Link> and the <Link href="/privacy" target="_blank">privacy policy</Link>.
            </AuthCheck>
            <AuthCheck id="sadult" checked={adult} onChange={(v) => { setAdult(v); clear("confirmAdult"); }} error={errors.confirmAdult ?? null}>
              I am 18 or older.
            </AuthCheck>

            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}

            <button type="submit" disabled={state !== "idle" || !hydrated} className="auth-btn" aria-live="polite">
              {state === "idle" && (<><span>Create my account</span><ArrowRight size={17} /></>)}
              {state === "loading" && (<><span className="auth-spinner" aria-hidden /><span>Setting things up…</span></>)}
              {state === "success" && (<><Check size={18} strokeWidth={3} /><span>Welcome aboard</span></>)}
            </button>
            <p className="auth-fine">
              We&apos;ll email you a link to confirm your address. Questions: <a href="mailto:creators@digitalsukoon.com">creators@digitalsukoon.com</a>.
            </p>
          </form>
        )}

        <GoogleSignIn mode="signup" initialCountry={country} onProfileStep={setGoogleStep} onSession={adoptSession} />
      </div>
    </AuthShell>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<AuthFallback title="Create your creator account." />}>
      <SignupForm />
    </Suspense>
  );
}
