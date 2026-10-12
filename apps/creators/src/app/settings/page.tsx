"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { creatorProfileSchema } from "@dashmani/shared/src/validators/creator";
import { apiFetch, ApiError, clearSession, fetcher } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorSentence } from "@/lib/messages";
import { countries } from "@/lib/countries";
import type { CreatorMe, CreatorMeWithChecklist } from "@/lib/types";
import { Banner, FieldError, Loading, Modal, PageHead } from "@/components/ui";

// Settings: profile (PUT /v1/creator/me), password (PUT /v1/creator/me/password) and closing the
// account (DELETE /v1/creator/me, behind a typed confirmation).

export default function SettingsPage() {
  const { data: me, error, isLoading, mutate } = useSWR<CreatorMeWithChecklist>("/creator/me", fetcher, { revalidateOnFocus: false });

  if (isLoading && !me) return <Loading label="Loading your settings…" />;
  if (error && !me) {
    return (
      <Banner tone="danger" role="alert" title="We couldn't load your settings." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
        {errorSentence(error)}
      </Banner>
    );
  }
  if (!me) return null;

  return (
    <div className="flex flex-col gap-8">
      <PageHead kicker="Settings" title="Your account." />
      <ProfileForm me={me} onSaved={(c) => mutate({ ...me, ...c }, { revalidate: false })} />
      <PasswordForm />
      <CloseAccount />
    </div>
  );
}

function Section({ title, children, intro }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card p-5 sm:p-7">
      <h2 className="text-xl font-extrabold tracking-[-0.03em]">{title}</h2>
      {intro && <div className="mt-1 text-sm text-ink-3 leading-relaxed max-w-2xl">{intro}</div>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ProfileForm({ me, onSaved }: { me: CreatorMe; onSaved: (c: CreatorMe) => void }) {
  const { updateCreator } = useAuth();
  const [name, setName] = useState(me.name);
  const [country, setCountry] = useState(me.country ?? "");
  const [phone, setPhone] = useState(me.phone ?? "");
  const [errors, setErrors] = useState<{ name?: string; country?: string; phone?: string }>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  // Intl names are built after mount so the static HTML and the first client render agree.
  const [list, setList] = useState<Array<{ code: string; name: string }>>([]);
  useEffect(() => setList(countries()), []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    const parsed = creatorProfileSchema.safeParse({ name, country, phone });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const i of parsed.error.issues) {
        const f = i.path[0] as keyof typeof errors;
        if (!next[f]) next[f] = f === "phone" ? "Keep the phone number under 32 characters" : i.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await apiFetch<CreatorMe>("/creator/me", {
        method: "PUT",
        body: JSON.stringify({ name: name.trim(), country, phone: phone.trim() }),
      });
      updateCreator(r.data);
      onSaved(r.data);
      setMsg({ tone: "success", text: "Saved." });
    } catch (err) {
      setMsg({ tone: "danger", text: errorSentence(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Profile" intro="Our team sees these details when reviewing your profile.">
      <form onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-2">
        <label className="field sm:col-span-2" htmlFor="pemail">
          <span className="field-label">Email</span>
          <input id="pemail" className="input opacity-70" value={me.email} readOnly aria-describedby="pemail-hint" />
          <span id="pemail-hint" className="text-xs text-ink-4">To change your email, write to creators@digitalsukoon.com.</span>
        </label>
        <label className="field sm:col-span-2" htmlFor="pname">
          <span className="field-label">Name</span>
          <input id="pname" className="input" value={name} autoComplete="name" onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }}
            aria-invalid={!!errors.name} aria-describedby={errors.name ? "pname-err" : undefined} />
          {errors.name && <FieldError id="pname-err">{errors.name}</FieldError>}
        </label>
        <label className="field" htmlFor="pcountry">
          <span className="field-label">Country</span>
          <select id="pcountry" className="input" value={country} autoComplete="country" onChange={(e) => { setCountry(e.target.value); setErrors((x) => ({ ...x, country: undefined })); }}
            aria-invalid={!!errors.country} aria-describedby={errors.country ? "pcountry-err" : undefined}>
            <option value="">Not set</option>
            {/* Keep the stored value selectable while the list builds after mount. */}
            {list.length === 0 && country && <option value={country}>{country}</option>}
            {list.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
          {errors.country && <FieldError id="pcountry-err">{errors.country}</FieldError>}
        </label>
        <label className="field" htmlFor="pphone">
          <span className="field-label">Phone (optional)</span>
          <input id="pphone" className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} placeholder="+44 7700 900123"
            onChange={(e) => { setPhone(e.target.value); setErrors((x) => ({ ...x, phone: undefined })); }}
            aria-invalid={!!errors.phone} aria-describedby={errors.phone ? "pphone-err" : undefined} />
          {errors.phone && <FieldError id="pphone-err">{errors.phone}</FieldError>}
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-sm" disabled={busy}>{busy ? <><span className="spinner" aria-hidden /> Saving…</> : "Save profile"}</button>
          <span aria-live="polite" className={`text-sm ${msg?.tone === "danger" ? "text-danger" : "text-success"}`}>{msg?.text}</span>
        </div>
      </form>
    </Section>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setMsg(null);
    if (!current) { setMsg({ tone: "danger", text: "Enter your current password." }); return; }
    if (next.length < 8) { setMsg({ tone: "danger", text: "Use at least 8 characters for the new password." }); return; }
    setBusy(true);
    try {
      await apiFetch("/creator/me/password", { method: "PUT", body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setCurrent(""); setNext("");
      setMsg({ tone: "success", text: "Password changed." });
    } catch (err) {
      setMsg({ tone: "danger", text: errorSentence(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Password" intro="Signed up with Google? Use “Forgot password” on the sign-in page to set one first.">
      <form onSubmit={save} noValidate className="grid gap-4 sm:grid-cols-2">
        <label className="field" htmlFor="cur">
          <span className="field-label">Current password</span>
          <input id="cur" className="input" type={show ? "text" : "password"} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field" htmlFor="newpw">
          <span className="field-label">New password</span>
          <input id="newpw" className="input" type={show ? "text" : "password"} autoComplete="new-password" value={next} placeholder="At least 8 characters" onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="sm:col-span-2 flex items-center gap-2 text-sm text-ink-3 cursor-pointer w-fit">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="accent-[#403cfa] w-4 h-4" />
          Show passwords
        </label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-sm" disabled={busy}>{busy ? <><span className="spinner" aria-hidden /> Saving…</> : "Change password"}</button>
          <span aria-live="polite" className={`text-sm ${msg?.tone === "danger" ? "text-danger" : "text-success"}`}>{msg?.text}</span>
        </div>
      </form>
    </Section>
  );
}

const CONFIRM_WORD = "CLOSE";

function CloseAccount() {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Close your account"
      intro={<>Closing your account disconnects Facebook, deletes our copy of your Facebook access, takes your pages off Digital Sukoon Creators and signs you out everywhere. It can&apos;t be undone from here.</>}
    >
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>Close my account</button>
      {open && <CloseModal onClose={() => setOpen(false)} />}
    </Section>
  );
}

function CloseModal({ onClose }: { onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);

  async function closeAccount(e: React.FormEvent) {
    e.preventDefault();
    if (typed.trim().toUpperCase() !== CONFIRM_WORD || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch("/creator/me", { method: "DELETE" });
      clearSession();
      setClosed(true);
    } catch (err) {
      setError(err instanceof ApiError ? errorSentence(err) : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  if (closed) {
    return (
      <Modal title="Your account is closed." onClose={() => { window.location.href = "/"; }}>
        <p className="text-sm text-ink-3 leading-relaxed">
          We&apos;ve disconnected Facebook and signed you out. To also remove our app from Facebook, go to Facebook → Settings → Business
          integrations. For anything else, email creators@digitalsukoon.com.
        </p>
        <button type="button" className="btn btn-sm self-end" onClick={() => { window.location.href = "/"; }}>Done</button>
      </Modal>
    );
  }

  return (
    <Modal title="Close your account?" onClose={onClose}>
      <form onSubmit={closeAccount} className="flex flex-col gap-4" noValidate>
        <p className="text-sm text-ink-3 leading-relaxed">
          Type <span className="font-mono text-white">{CONFIRM_WORD}</span> to confirm. Your pages stop being offered for booking at once.
        </p>
        <label className="field" htmlFor="closeword">
          <span className="field-label">Confirmation</span>
          <input id="closeword" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        {error && <Banner tone="danger" role="alert">{error}</Banner>}
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Keep my account</button>
          <button type="submit" className="btn btn-danger btn-sm" disabled={typed.trim().toUpperCase() !== CONFIRM_WORD || busy}>
            {busy ? <><span className="spinner" aria-hidden /> Closing…</> : "Close my account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
