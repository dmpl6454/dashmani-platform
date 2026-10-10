"use client";
import { useEffect, useRef, useState } from "react";
import type { InternalSession } from "@/lib/auth";

/* "Sign in with Google" for the internal portal, under the password form on /login.
   Real wire, no mock: the Google Identity Services button yields an ID token, which goes to
   POST /v1/auth/google; the API verifies it with Google and answers the same session shape as
   password login. The portal is INVITE-ONLY, so this only ever signs in an existing active
   account — a Google email with no account is refused by the API with an honest message that is
   shown in the page's own error banner (this component renders no error text itself).
   The OAuth client id comes from GET /v1/auth/google/config at runtime, so the button simply
   does not render while the server has no GOOGLE_CLIENT_ID — nothing fake is ever shown. */

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

/* Plain fetch on purpose, not apiFetch: these two calls are PUBLIC and carry no token. apiFetch
   answers any 401 by trying a token refresh and then redirecting to /login (a full reload), which
   would wipe the error message for a rejected Google token. */
async function publicCall<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json" } });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  let body: { success?: boolean; data?: T; error?: { message?: string } } | null = null;
  try { body = await res.json(); } catch { /* non-JSON proxy error page */ }
  if (!body?.success) throw new Error(body?.error?.message || "Google sign-in did not go through. Please try again.");
  return body.data as T;
}

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
  rememberMe,
  disabled,
  onSession,
  onError,
}: {
  /** The page's "Keep me signed in" checkbox — honoured exactly as password login does. */
  rememberMe: boolean;
  /** While the password form is mid-submit, so two sessions cannot be minted at once. */
  disabled?: boolean;
  onSession: (s: InternalSession) => void;
  onError: (message: string) => void;
}) {
  const [clientId, setClientId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  // Read through a ref so the (once-registered) Google callback always sees the live checkbox.
  const live = useRef({ onSession, onError, disabled, rememberMe });
  live.current = { onSession, onError, disabled, rememberMe };

  // 1. Is it set up on the server?
  useEffect(() => {
    let alive = true;
    publicCall<{ enabled: boolean; clientId: string | null }>("/auth/google/config")
      .then((r) => { if (alive && r.enabled && r.clientId) setClientId(r.clientId); })
      .catch(() => { /* no button rather than a broken one */ });
    return () => { alive = false; };
  }, []);

  // 2. Exchange the credential for a session.
  async function exchange(credential: string) {
    if (live.current.disabled) return;
    setBusy(true);
    try {
      const session = await publicCall<InternalSession>("/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential, rememberMe: live.current.rememberMe }),
      });
      live.current.onSession(session);
    } catch (err: unknown) {
      live.current.onError(err instanceof Error && err.message ? err.message : "Google sign-in did not go through. Please try again.");
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
          text: "signin_with",
          logo_alignment: "left",
          width: Math.min(400, Math.max(200, Math.floor(el.getBoundingClientRect().width || 320))),
        });
      })
      .catch((e: Error) => { if (!cancelled) live.current.onError(e.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  if (!clientId) return null;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-3 mb-4 font-mono text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-4" aria-hidden>
        <span className="flex-1 h-px bg-ink-4/25" />
        <span>or</span>
        <span className="flex-1 h-px bg-ink-4/25" />
      </div>
      <div ref={slot} className="flex justify-center min-h-[44px]" aria-busy={busy} />
      {busy && <p className="text-[11.5px] text-ink-3 text-center mt-2 font-medium" aria-live="polite">Checking with Google…</p>}
    </div>
  );
}
