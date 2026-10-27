"use client";
import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertCircle, ArrowRight } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth, type ClientSession } from "@/lib/auth";
import { AuthField, AuthShell } from "@/components/auth/shared";
import { useHydrated } from "@/lib/hooks/use-hydrated";

// Accept a team invite: someone on a client account (or our sales team) added this person.
// GET /v1/client/auth/join/:token says who it is for; POST /v1/client/auth/join sets their
// password and signs them in to that company's portal.

function JoinForm() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const { adoptSession } = useAuth();
  const hydrated = useHydrated();

  const [invite, setInvite] = useState<{ email: string; name: string; companyName: string } | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    apiFetch<{ email: string; name: string; companyName: string }>(`/client/auth/join/${encodeURIComponent(token)}`)
      .then((r) => {
        setInvite(r.data);
        setName(r.data.name);
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : "This invite link can't be opened."));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError("Add your name.");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch<ClientSession>("/client/auth/join", {
        method: "POST",
        body: JSON.stringify({ token, password, name: name.trim() }),
      });
      adoptSession(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join. The link may have expired.");
      setLoading(false);
    }
  }

  return (
    <AuthShell
      kicker="CH 07 · Client portal"
      title={<>Join your <em>team.</em></>}
      lines={[
        <>{invite ? <>You&apos;ve been added to <strong>{invite.companyName}</strong>&apos;s client portal.</> : "You've been added to a client account."} Set a password to start.</>,
        <>Already joined? <Link href="/login">Sign in</Link>.</>,
      ]}
    >
      <div className="auth-form-inner">
        <div className="auth-form-head">
          <h2>{invite ? `Join ${invite.companyName}.` : "Join your team."}</h2>
          <p>{invite ? <>You&apos;ll sign in as <strong>{invite.email}</strong>.</> : "Checking your invite…"}</p>
        </div>

        {!token ? (
          <div className="auth-err"><AlertCircle size={14} /> <span>This invite link is incomplete. Open the link from your email again.</span></div>
        ) : loadErr ? (
          <div className="auth-err"><AlertCircle size={14} /> <span>{loadErr}</span></div>
        ) : invite ? (
          <form onSubmit={handleSubmit} noValidate className="auth-form">
            <AuthField id="jn-name" label="Your name" type="text" autoComplete="name" placeholder="Your name"
              value={name} onChange={(v) => { setName(v); if (error) setError(""); }} error={null} />
            <AuthField id="jn-pw" label="Password" type="password" autoComplete="new-password" placeholder="At least 8 characters"
              value={password} onChange={(v) => { setPassword(v); if (error) setError(""); }} error={null}
              showPass={showPass} onToggleShowPass={() => setShowPass((s) => !s)} />
            {error && <div role="alert" className="auth-err"><AlertCircle size={14} /> <span>{error}</span></div>}
            <button type="submit" disabled={loading || !hydrated} className="auth-btn">
              {loading ? (<><span className="auth-spinner" aria-hidden /><span>Joining…</span></>) : (<><span>Join and sign in</span><ArrowRight size={17} /></>)}
            </button>
          </form>
        ) : null}
      </div>
    </AuthShell>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <JoinForm />
    </Suspense>
  );
}
