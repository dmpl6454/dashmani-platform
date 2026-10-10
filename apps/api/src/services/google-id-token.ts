/**
 * "Sign in with Google" — server-side verification of a Google Identity Services ID token.
 *
 * The browser's GIS button hands the page a signed ID token (the `credential`). Nothing in
 * it is trusted until Google itself confirms it: we ask Google's tokeninfo endpoint, which
 * validates the signature and returns the claims, and then check the four things Google's
 * docs require of a relying party — the audience is OUR client id, the issuer is Google,
 * the token is unexpired, and the email is verified. A token minted for any other app, or
 * one carrying an unverified address, is refused.
 *
 * ⚠️ `GOOGLE_CLIENT_ID` is runtime-only (read on every call, never at module load, so the
 * tests can set it) and lives in apps/api/.env. The same id is served to the browser by
 * GET /v1/client/auth/google/config, so the portal needs no NEXT_PUBLIC_* rebuild and the
 * deploy script's .env.local overwrite cannot lose it.
 */
import { AppError } from "../middleware/error-handler";

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  givenName: string | null;
  /** Google Workspace domain, when the account belongs to one. */
  hostedDomain: string | null;
}

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const REQUEST_TIMEOUT_MS = 8000;

export function googleClientId(): string | null {
  const id = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  return id.length > 0 ? id : null;
}

export function googleSignInEnabled(): boolean {
  return googleClientId() !== null;
}

/** Verify a GIS credential with Google and return the identity it proves, or throw a 401. */
export async function verifyGoogleIdToken(credential: string): Promise<GoogleIdentity> {
  const clientId = googleClientId();
  if (!clientId) throw new AppError(503, "GOOGLE_SIGNIN_DISABLED", "Sign in with Google is not set up on this server");
  if (typeof credential !== "string" || credential.length < 20 || credential.length > 4096 || !/^[A-Za-z0-9_.-]+$/.test(credential)) {
    throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified. Please try again.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let claims: Record<string, unknown>;
  try {
    const res = await fetch(`${TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`, { signal: controller.signal });
    // Google answers 400 for a malformed, expired or badly-signed token — a client error, not ours.
    if (res.status >= 500) throw new AppError(503, "GOOGLE_UNAVAILABLE", "Google did not answer. Please try again in a moment.");
    claims = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified. Please try again.");
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, "GOOGLE_UNAVAILABLE", "Google did not answer. Please try again in a moment.");
  } finally {
    clearTimeout(timer);
  }

  const str = (k: string) => (typeof claims[k] === "string" ? (claims[k] as string) : "");
  if (str("aud") !== clientId) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "This Google sign-in was not issued for this portal.");
  if (!GOOGLE_ISSUERS.has(str("iss"))) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified. Please try again.");
  const exp = Number(str("exp"));
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "This Google sign-in has expired. Please try again.");
  // tokeninfo returns booleans as the strings "true"/"false".
  if (str("email_verified") !== "true" && claims.email_verified !== true) {
    throw new AppError(401, "GOOGLE_EMAIL_UNVERIFIED", "Your Google account's email address is not verified, so it cannot be used to sign in.");
  }
  const email = str("email").trim().toLowerCase();
  const sub = str("sub");
  if (!email.includes("@") || !sub) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google sign-in could not be verified. Please try again.");

  const name = str("name").trim() || email.split("@")[0];
  return {
    sub,
    email,
    name,
    givenName: str("given_name").trim() || null,
    hostedDomain: str("hd").trim() || null,
  };
}
