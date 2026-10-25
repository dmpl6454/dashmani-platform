"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { HrUser } from "@/lib/auth";

/* "Sign in with Google" for the HR portal, under both tabs of /login.
   Real wire, no mock: the Google Identity Services button yields an ID token, which goes to
   POST /v1/hr/auth/google; the API verifies it with Google and answers the same session shape
   as password login (plus `created`, true when this first sign-in just opened the account —
   Google supplies the name and the email, which is all HR self-registration needs).
   The OAuth client id comes from GET /v1/hr/auth/google/config at runtime, so the button simply
   does not render while the server has no GOOGLE_CLIENT_ID — nothing fake is ever shown. */

export type GoogleHrSession = {
  accessToken: string;
  refreshToken: string;
  user: HrUser & { roles?: string[]; profileImageUrl?: string | null };
  created: boolean;
};

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

export function GoogleSignIn({
  mode,
  disabled,
  onSession,
  onError,
}: {
  mode: "signin" | "signup";
  /** While the password form is mid-submit, so two sessions cannot be minted at once. */
  disabled?: boolean;
  onSession: (s: GoogleHrSession) => void;
  /** Surfaced in the page's own error banner; the component renders no error text itself. */
  onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const cb = useRef({ onSession, onError, disabled });
  cb.current = { onSession, onError, disabled };

  // 1. Is it set up on the server?
  useEffect(() => {
    let alive = true;
    apiFetch<{ data: { enabled: boolean; clientId: string | null } }>("/hr/auth/google/config")
      .then((r) => { if (alive && r.data.enabled && r.data.clientId) setClientId(r.data.clientId); })
      .catch(() => { /* no button rather than a broken one */ });
    return () => { alive = false; };
  }, []);

  // 2. Exchange the credential for a session.
  async function exchange(credential: string) {
    if (cb.current.disabled) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ data: GoogleHrSession }>("/hr/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      cb.current.onSession(r.data);
    } catch (err: unknown) {
      cb.current.onError(err instanceof Error && err.message ? err.message : "Google sign-in did not go through. Please try again.");
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
          theme: "outline",
          size: "large",
          shape: "pill",
          text: mode === "signup" ? "signup_with" : "signin_with",
          logo_alignment: "left",
          width: Math.min(400, Math.max(200, Math.floor(el.getBoundingClientRect().width || 320))),
        });
      })
      .catch((e: Error) => { if (!cancelled) cb.current.onError(e.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, mode]);

  if (!clientId) return null;

  return (
    <div className="auth-google">
      <div className="auth-or" aria-hidden><span>or</span></div>
      <div ref={slot} className="auth-google-slot" aria-busy={busy} />
      {busy && <p className="text-[11.5px] text-[#6C6555] text-center mt-2 font-medium" aria-live="polite">Checking with Google…</p>}
    </div>
  );
}
