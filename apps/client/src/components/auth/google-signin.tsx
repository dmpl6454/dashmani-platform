"use client";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { AuthField } from "./shared";

/* "Sign in with Google" for the client portal, on /login and /signup.
   Real wire, no mock: the Google Identity Services button yields an ID token, which goes to
   POST /v1/client/auth/google; the API verifies it with Google and answers either a session
   (same shape as password login) or `needsProfile`, in which case a first-time client is
   asked for their company name here and the token is sent once more with it.
   The OAuth client id comes from GET /v1/client/auth/google/config at runtime, so the
   button simply does not render while the server has no GOOGLE_CLIENT_ID — nothing fake
   is ever shown. */

type Session = { accessToken: string; refreshToken: string; user: unknown };
type GoogleAnswer = Session | { needsProfile: true; email: string; name: string; suggestedCompany: string | null };

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
      s.onerror = () => { gisLoading = null; reject(new Error("Google sign-in failed to load")); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

export function GoogleSignIn({ mode, onSession }: { mode: "signin" | "signup"; onSession: (s: Session) => void }) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ email: string; name: string; suggestedCompany: string | null } | null>(null);
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const slot = useRef<HTMLDivElement>(null);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  // 1. Is it set up on the server?
  useEffect(() => {
    let alive = true;
    apiFetch<{ enabled: boolean; clientId: string | null }>("/client/auth/google/config")
      .then((r) => { if (alive && r.data.enabled && r.data.clientId) setClientId(r.data.clientId); })
      .catch(() => { /* no button rather than a broken one */ });
    return () => { alive = false; };
  }, []);

  // 2. Exchange the credential; ask for a company name on a first sign-in.
  async function exchange(cred: string, companyName?: string) {
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch<GoogleAnswer>("/client/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential: cred, ...(companyName ? { companyName } : {}) }),
      });
      if ("needsProfile" in r.data) {
        const p = r.data;
        setCredential(cred);
        setProfile({ email: p.email, name: p.name, suggestedCompany: p.suggestedCompany });
        setCompany((c) => c || p.suggestedCompany || "");
      } else {
        onSessionRef.current(r.data);
      }
    } catch (err: any) {
      setError(err?.message || "Google sign-in did not go through. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // 3. Render Google's button once the script and the id are both here.
  useEffect(() => {
    if (!clientId || !slot.current) return;
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
  }, [clientId, mode]);

  if (!clientId) return null;

  if (profile && credential) {
    return (
      <form
        className="auth-form auth-google-profile"
        onSubmit={(e) => { e.preventDefault(); if (company.trim().length < 2) { setError("Tell us your company or brand name."); return; } void exchange(credential, company.trim()); }}
        noValidate
      >
        <p className="auth-google-hello">
          Hi {profile.name.split(" ")[0]} — Google confirmed <strong>{profile.email}</strong>. One more thing to open your account.
        </p>
        <AuthField id="gcompany" label="Company or brand" autoComplete="organization" placeholder="Acme Studios"
          value={company} onChange={(v) => { setCompany(v); if (error) setError(""); }} error={null} />
        {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
        <button type="submit" disabled={busy} className="auth-btn" aria-live="polite">
          {busy ? (<><span className="auth-spinner" aria-hidden /><span>Setting things up…</span></>) : (<><span>Create my account</span><ArrowRight size={17} /></>)}
        </button>
        <button type="button" className="auth-link" onClick={() => { setProfile(null); setCredential(null); setError(""); }}>Use a different account</button>
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
