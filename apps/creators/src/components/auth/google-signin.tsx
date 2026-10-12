"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { CreatorSession } from "@/lib/types";
import { AuthCheck, AuthCountry } from "./shared";

/* "Continue with Google" on /login and /signup (adapted from the client portal's).
   Real wire, no mock: Google Identity Services yields an ID token, which goes to
   POST /v1/creator/auth/google. The API verifies it with Google and answers either a session or
   `needsProfile` (a first-time creator — nothing written yet), in which case we ask for the
   country and the two confirmations (creator terms, 18+) and send the token once more with them.
   The OAuth client id comes from GET /v1/creator/auth/google/config at runtime: while the server
   has no GOOGLE_CLIENT_ID the button simply is not rendered — nothing fake is ever shown. */

type GoogleAnswer = CreatorSession | { needsProfile: true; email: string; name: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, cfg: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
let gisLoading: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { gisLoading = null; reject(new Error("Google sign-in failed to load. Use your email and password instead.")); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

export function GoogleSignIn({ mode, onSession, initialCountry, onProfileStep }: {
  mode: "signin" | "signup";
  onSession: (s: CreatorSession) => void;
  /** The country already picked on the sign-up form, to prefill the profile step. */
  initialCountry?: string;
  /** Told when the profile step opens/closes, so the host page can hide its own form meanwhile. */
  onProfileStep?: (active: boolean) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ email: string; name: string } | null>(null);
  const [country, setCountry] = useState("");
  const [terms, setTerms] = useState(false);
  const [adult, setAdult] = useState(false);
  const [fieldErr, setFieldErr] = useState<{ terms?: string; adult?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = useRef<HTMLDivElement>(null);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const initialCountryRef = useRef(initialCountry);
  initialCountryRef.current = initialCountry;
  const onProfileStepRef = useRef(onProfileStep);
  onProfileStepRef.current = onProfileStep;
  const profileStep = !!(profile && credential);

  useEffect(() => { onProfileStepRef.current?.(profileStep); }, [profileStep]);
  // The profile step replaces the button (and the form above it): move focus to its greeting.
  const helloRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (profileStep) helloRef.current?.focus(); }, [profileStep]);
  useEffect(() => () => { onProfileStepRef.current?.(false); }, []);

  // 1. Is it set up on the server?
  useEffect(() => {
    let alive = true;
    apiFetch<{ enabled: boolean; clientId: string | null }>("/creator/auth/google/config")
      .then((r) => { if (alive && r.data.enabled && r.data.clientId) setClientId(r.data.clientId); })
      .catch(() => { /* no button rather than a broken one */ });
    return () => { alive = false; };
  }, []);

  // 2. Exchange the credential; a first-time creator gets the profile step.
  async function exchange(cred: string, extra?: { country?: string; acceptTerms: true; confirmAdult: true }) {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<GoogleAnswer>("/creator/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential: cred, ...(extra ?? {}) }),
      });
      if ("needsProfile" in r.data) {
        setCredential(cred);
        setProfile({ email: r.data.email, name: r.data.name });
        setCountry(initialCountryRef.current || "");
      } else {
        onSessionRef.current(r.data);
      }
    } catch (err) {
      setError(errorSentence(err, "Google sign-in didn't go through. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  // 3. Render Google's button once the script and the id are both here (and again when the
  //    profile step closes, since its slot was unmounted meanwhile).
  useEffect(() => {
    if (!clientId || profileStep || !slot.current) return;
    let cancelled = false;
    const el = slot.current;
    loadGis()
      .then(() => {
        if (cancelled || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp: { credential?: string }) => { if (resp?.credential) void exchange(resp.credential); },
          ux_mode: "popup",
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
        });
        el.innerHTML = "";
        window.google.accounts.id.renderButton(el, {
          theme: "filled_black",
          size: "large",
          shape: "rectangular",
          text: mode === "signup" ? "signup_with" : "signin_with",
          logo_alignment: "left",
          width: Math.min(400, Math.max(200, Math.floor(el.getBoundingClientRect().width || 320))),
        });
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, mode, profileStep]);

  if (!clientId) return null;

  const leaveProfile = () => {
    setProfile(null); setCredential(null); setError(""); setFieldErr({}); setTerms(false); setAdult(false);
  };

  if (profile && credential) {
    return (
      <form
        className="auth-form auth-google-profile"
        onSubmit={(e) => {
          e.preventDefault();
          const errs: { terms?: string; adult?: string } = {};
          if (!terms) errs.terms = "Please accept the creator terms";
          if (!adult) errs.adult = "You must be 18 or older";
          setFieldErr(errs);
          if (errs.terms || errs.adult) return;
          void exchange(credential, { ...(country ? { country } : {}), acceptTerms: true, confirmAdult: true });
        }}
        noValidate
      >
        <p ref={helloRef} tabIndex={-1} className="auth-google-hello outline-none">
          Hi {profile.name.split(" ")[0] || "there"} — Google confirmed <strong>{profile.email}</strong>. Two quick things to open your creator account.
        </p>
        <AuthCountry id="gcountry" value={country} onChange={setCountry} error={null} />
        <AuthCheck id="gterms" checked={terms} onChange={(v) => { setTerms(v); setFieldErr((f) => ({ ...f, terms: undefined })); }} error={fieldErr.terms ?? null}>
          I agree to the <Link href="/terms" target="_blank">creator terms</Link> and the <Link href="/privacy" target="_blank">privacy policy</Link>.
        </AuthCheck>
        <AuthCheck id="gadult" checked={adult} onChange={(v) => { setAdult(v); setFieldErr((f) => ({ ...f, adult: undefined })); }} error={fieldErr.adult ?? null}>
          I am 18 or older.
        </AuthCheck>
        {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
        <button type="submit" disabled={busy} className="auth-btn" aria-live="polite">
          {busy ? (<><span className="auth-spinner" aria-hidden /><span>Setting things up…</span></>) : (<><span>Create my creator account</span><ArrowRight size={17} /></>)}
        </button>
        <div className="auth-row">
          <button type="button" className="auth-link" onClick={leaveProfile}>Use a different account</button>
          {onProfileStep && <button type="button" className="auth-link" onClick={leaveProfile}>Use email instead</button>}
        </div>
      </form>
    );
  }

  return (
    <div className="auth-google">
      <div className="auth-or" aria-hidden><span>or</span></div>
      <div ref={slot} className="auth-google-slot" aria-busy={busy} />
      {busy && <p className="auth-fine">Checking with Google…</p>}
      {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
    </div>
  );
}
