"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  PAYOUT_FIELD_REJECTED,
  PAYOUT_FORM_FIELDS,
  PAYOUT_STATE_CHOICES,
  creatorPayoutAccountSchema,
  formFieldForReference,
  type PayoutFormField,
} from "@dashmani/shared/src/validators/creator-payout";
import { apiFetch, ApiError } from "@/lib/api";
import { payoutErrorFields, payoutErrorSentence, payoutFailureIsDefinite } from "@/lib/messages";
import { useHydrated } from "@/lib/use-hydrated";
import type { PayoutAccountResponse } from "@/lib/types";
import { Banner, FieldError } from "@/components/ui";

// The bank-connect form (PUT /v1/creator/payout-account).
//
// ⚠️ PRIVACY, the point of this file. The PAN, bank account number, IFSC, name and address a creator
// types here go to our API in ONE request and from there to Razorpay; we keep none of them. So, here:
//   • the values live ONLY in React state. No localStorage, sessionStorage, cookie, URL or query string,
//     no draft auto-save, nothing sent to analytics, no console output. A reload starts empty on purpose.
//   • inputs carry no `name` attribute. A form submitted natively (a tap before hydration) sends only
//     NAMED fields, so even that path could not put a value in the URL; the submit button is also
//     disabled until React has hydrated, and the page does not render the form before its own data loads.
//   • the PAN and account number are masked with a reveal toggle, as a text input drawn with dots rather
//     than a password input (a password manager would offer to SAVE a password field's contents).
//   • autocomplete is off for the PAN, account number and IFSC, with the hints password managers read.
//   • after a success, and after a DEFINITE refusal, the PAN and bank fields are wiped from state. After
//     an uncertain outcome (no connection, a 5xx, a busy answer) they are kept so the press can be repeated.
//   • no error text is ever the API's own wording (payoutErrorSentence): ours, picked by code.
// The CI guard `no-raw-payout-identifiers` allow-lists THIS file (and only this one in the app), because
// the form has to name the fields it sends. Everything else in the app reads them through
// formFieldForReference / FIELD_LABELS below.

type FieldKey = PayoutFormField | "confirmAccount" | "consent";
type Values = Record<PayoutFormField, string>;
type Errors = Partial<Record<FieldKey, string>>;

const EMPTY: Values = {
  fullName: "",
  pan: "",
  phone: "",
  "address.street1": "",
  "address.street2": "",
  "address.city": "",
  "address.state": "",
  "address.postalCode": "",
  accountNumber: "",
  ifsc: "",
};

/** The order fields appear in, so the first invalid one is the one focused. */
const ORDER: FieldKey[] = [
  "fullName",
  "pan",
  "phone",
  "address.street1",
  "address.street2",
  "address.city",
  "address.state",
  "address.postalCode",
  "accountNumber",
  "confirmAccount",
  "ifsc",
  "consent",
];

/** What each field is called in a message. Also read by the status card, so a Razorpay requirement reads as a name. */
export const FIELD_LABELS: Record<PayoutFormField, string> = {
  fullName: "Full name",
  pan: "PAN",
  phone: "Phone number",
  "address.street1": "Street address",
  "address.street2": "Address line 2",
  "address.city": "City",
  "address.state": "State",
  "address.postalCode": "PIN code",
  accountNumber: "Bank account number",
  ifsc: "IFSC code",
};

/** A Razorpay requirement reference as a person reads it. A reference this form has no field for reads generically. */
export function requirementLabel(reference: string): string {
  const f = formFieldForReference(reference);
  if (!f) return "Another detail Razorpay asked for";
  return f === "fullName" ? "Name as on your PAN and bank account" : FIELD_LABELS[f];
}

/** The form fields a list of Razorpay references is about (each once), for marking them when the form opens. */
export function fieldsForReferences(references: string[]): PayoutFormField[] {
  const out: PayoutFormField[] = [];
  for (const r of references) {
    const f = formFieldForReference(r);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

const SMALL_WORDS = new Set(["and"]);
/** "TAMIL NADU" → "Tamil Nadu" for display; the option's value stays Razorpay's spelling. */
function stateLabel(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w) => (SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

const squash = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();

function keyForPath(path: Array<string | number>): FieldKey | "termsVersion" | null {
  const p = path.join(".");
  if (p === "acceptTerms") return "consent";
  if (p === "termsVersion") return "termsVersion";
  return (PAYOUT_FORM_FIELDS as readonly string[]).includes(p) ? (p as PayoutFormField) : null;
}

/** Whether the browser can draw a text input as dots. Read after mount; until then the static render assumes it can. */
function useTextSecurity(): boolean {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    try {
      setOk(typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc"));
    } catch {
      setOk(false);
    }
  }, []);
  return ok;
}

type Register = (key: FieldKey) => (el: HTMLElement | null) => void;

interface FieldShellProps {
  id: string;
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (describedBy: string | undefined) => ReactNode;
}

/** Label, control, hint and error with the aria wiring every control shares. */
function Shell({ id, label, optional, hint, error, className = "", children }: FieldShellProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id} className="field-label">
        {label}
        {optional && <span className="normal-case tracking-normal text-ink-4"> (optional)</span>}
      </label>
      {children(describedBy)}
      {hint && <span id={hintId} className="text-xs text-ink-4 leading-relaxed">{hint}</span>}
      {error && <FieldError id={errId!}>{error}</FieldError>}
    </div>
  );
}

// 16px (`text-base`) on every control: iOS Safari zooms into a focused field set any smaller.
const CONTROL = "input text-base";

interface TextProps {
  fkey: FieldKey;
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  register: Register;
  error?: string;
  optional?: boolean;
  hint?: ReactNode;
  className?: string;
  /** Masked with a reveal toggle, and kept away from password managers. */
  secret?: boolean;
  attrs?: React.InputHTMLAttributes<HTMLInputElement>;
}

function TextField({ fkey, id, label, value, onChange, register, error, optional, hint, className, secret, attrs }: TextProps) {
  const textSecurity = useTextSecurity();
  const [shown, setShown] = useState(false);
  const masked = !!secret && !shown;
  const pr = secret ? " pr-12" : "";
  return (
    <Shell id={id} label={label} optional={optional} hint={hint} error={error} className={className}>
      {(describedBy) => (
        <div className="relative">
          <input
            {...attrs}
            ref={register(fkey) as (el: HTMLInputElement | null) => void}
            id={id}
            // A text input drawn as dots where the browser can (see useTextSecurity); a password input only where it cannot.
            type={masked && !textSecurity ? "password" : attrs?.type ?? "text"}
            className={`${CONTROL}${pr}${masked && textSecurity ? " input-masked" : ""}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            autoCorrect="off"
            {...(secret ? { "data-1p-ignore": true, "data-lpignore": "true", "data-bwignore": "true", "data-form-type": "other" } : {})}
          />
          {secret && (
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              aria-pressed={shown}
              aria-label={`${shown ? "Hide" : "Show"} ${label.toLowerCase()}`}
              className="absolute inset-y-0 right-0 w-11 grid place-items-center text-ink-3 hover:text-white"
            >
              {shown ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

function Section({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-7">
      <h2 className="text-xl font-extrabold tracking-[-0.03em]">{title}</h2>
      {intro && <div className="mt-1 text-sm text-ink-3 leading-relaxed max-w-2xl">{intro}</div>}
      <div className="mt-5 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export interface PayoutFormProps {
  /** The creator terms version GET /creator/payout-account returned; PUT must echo it. */
  termsVersion: string;
  /** The verified email the payout account is opened under (shown, never editable here). */
  email: string | null;
  /** Fields Razorpay refused last time (from the stored requirement references): marked when the form opens. */
  rejected: PayoutFormField[];
  /** The API answered with the new account state. */
  onDone: (r: PayoutAccountResponse) => void;
  /** The server's state may have changed (a refusal, an uncertain outcome): read it again. */
  onChanged: () => void;
}

export function PayoutForm({ termsVersion, email, rejected, onDone, onChanged }: PayoutFormProps) {
  const hydrated = useHydrated();
  const [values, setValues] = useState<Values>(EMPTY);
  const [confirm, setConfirm] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Errors>(() => {
    const e: Errors = {};
    for (const f of rejected) e[f] = PAYOUT_FIELD_REJECTED[f];
    return e;
  });
  const [formError, setFormError] = useState<{ text: string; cleared: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // Set synchronously: two quick taps can both pass a `busy` check that React has not flushed yet.
  const sending = useRef(false);
  const refs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  const bannerRef = useRef<HTMLDivElement>(null);

  const register: Register = (key) => (el) => {
    refs.current[key] = el;
  };

  function set(field: PayoutFormField, v: string) {
    setValues((x) => ({ ...x, [field]: v }));
    setErrors((x) => (x[field] ? { ...x, [field]: undefined } : x));
  }

  function focusFirst(errs: Errors) {
    const first = ORDER.find((k) => errs[k]);
    if (first) refs.current[first]?.focus();
    else bannerRef.current?.focus();
  }

  /** Everything the form holds, gone. */
  function wipe() {
    setValues(EMPTY);
    setConfirm("");
    setConsent(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hydrated || busy || sending.current) return;
    setFormError(null);

    const parsed = creatorPayoutAccountSchema.safeParse({
      fullName: values.fullName,
      pan: values.pan,
      phone: values.phone,
      address: {
        street1: values["address.street1"],
        street2: values["address.street2"] || undefined,
        city: values["address.city"],
        state: values["address.state"],
        postalCode: values["address.postalCode"],
      },
      accountNumber: values.accountNumber,
      ifsc: values.ifsc,
      acceptTerms: consent,
      termsVersion,
    });
    const next: Errors = {};
    let reload = false;
    if (!parsed.success) {
      // The schema's messages are generic by design (they never quote what was typed).
      for (const issue of parsed.error.issues) {
        const key = keyForPath(issue.path);
        if (key === "termsVersion") reload = true;
        else if (key && !next[key]) next[key] = issue.message;
      }
    }
    if (!next.accountNumber && squash(values.accountNumber) !== squash(confirm)) {
      next.confirmAccount = "The two account numbers don't match";
    }
    if (!parsed.success || Object.keys(next).length > 0) {
      setErrors(next);
      if (reload) setFormError({ text: "Reload the page and try again.", cleared: false });
      else if (Object.keys(next).length === 0) setFormError({ text: "Some details didn't pass our check. Please try again.", cleared: false });
      focusFirst(next);
      return;
    }

    setErrors({});
    sending.current = true;
    setBusy(true);
    try {
      const r = await apiFetch<PayoutAccountResponse>("/creator/payout-account", {
        method: "PUT",
        body: JSON.stringify(parsed.data),
      });
      wipe();
      onDone(r.data);
    } catch (err) {
      const definite = payoutFailureIsDefinite(err);
      const named: Errors = {};
      for (const f of payoutErrorFields(err)) named[f.field] = f.message;
      if (definite) {
        // The server has answered for these values: nothing is to be re-sent, so they do not stay in memory.
        setValues((x) => ({ ...x, pan: "", accountNumber: "", ifsc: "" }));
        setConfirm("");
      }
      if (err instanceof ApiError && err.code === "TERMS_CHANGED") setConsent(false);
      setErrors(named);
      setFormError({ text: payoutErrorSentence(err), cleared: definite });
      onChanged();
      // After the render, so a field cleared above is focusable with its error attached.
      setTimeout(() => focusFirst(named), 0);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const stateOptions = PAYOUT_STATE_CHOICES;

  return (
    <form onSubmit={submit} noValidate autoComplete="off" className="flex flex-col gap-6" aria-label="Bank account details">
      <Section
        title="About you"
        intro={
          <>
            Enter these exactly as they appear on your PAN card.{" "}
            {email && <>Your payout account is opened under your confirmed email, <span className="text-white break-words">{email}</span>.</>}
          </>
        }
      >
        <TextField
          fkey="fullName"
          id="payout-fullname"
          label="Full name"
          className="sm:col-span-2"
          value={values.fullName}
          onChange={(v) => set("fullName", v)}
          register={register}
          error={errors.fullName}
          hint="We use this name for your PAN and as the account holder name, so your bank account should be in the same name."
          attrs={{ autoComplete: "name", autoCapitalize: "words", spellCheck: false, maxLength: 120 }}
        />
        <TextField
          fkey="pan"
          id="payout-pan"
          label="PAN"
          secret
          value={values.pan}
          onChange={(v) => set("pan", v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
          register={register}
          error={errors.pan}
          hint="Your personal PAN: five letters, four digits and a letter. The fourth letter is P."
          attrs={{
            autoComplete: "off",
            autoCapitalize: "characters",
            spellCheck: false,
            inputMode: "text",
            maxLength: 10,
            pattern: "[A-Za-z]{3}[Pp][A-Za-z][0-9]{4}[A-Za-z]",
          }}
        />
        <TextField
          fkey="phone"
          id="payout-phone"
          label="Phone number"
          value={values.phone}
          onChange={(v) => set("phone", v)}
          register={register}
          error={errors.phone}
          hint="An Indian mobile number, with or without +91."
          attrs={{ type: "tel", inputMode: "tel", autoComplete: "tel", maxLength: 20 }}
        />
      </Section>

      <Section title="Address" intro="Your address in India.">
        <TextField
          fkey="address.street1"
          id="payout-street1"
          label="Street address"
          className="sm:col-span-2"
          value={values["address.street1"]}
          onChange={(v) => set("address.street1", v)}
          register={register}
          error={errors["address.street1"]}
          attrs={{ autoComplete: "address-line1", maxLength: 100 }}
        />
        <TextField
          fkey="address.street2"
          id="payout-street2"
          label="Address line 2"
          optional
          className="sm:col-span-2"
          value={values["address.street2"]}
          onChange={(v) => set("address.street2", v)}
          register={register}
          error={errors["address.street2"]}
          attrs={{ autoComplete: "address-line2", maxLength: 100 }}
        />
        <TextField
          fkey="address.city"
          id="payout-city"
          label="City"
          value={values["address.city"]}
          onChange={(v) => set("address.city", v)}
          register={register}
          error={errors["address.city"]}
          attrs={{ autoComplete: "address-level2", maxLength: 100 }}
        />
        <Shell id="payout-state" label="State" error={errors["address.state"]}>
          {(describedBy) => (
            <select
              ref={register("address.state") as (el: HTMLSelectElement | null) => void}
              id="payout-state"
              className={CONTROL}
              value={values["address.state"]}
              onChange={(e) => set("address.state", e.target.value)}
              aria-invalid={!!errors["address.state"]}
              aria-describedby={describedBy}
              autoComplete="address-level1"
            >
              <option value="">Select a state</option>
              {stateOptions.map((s) => (
                <option key={s} value={s}>{stateLabel(s)}</option>
              ))}
            </select>
          )}
        </Shell>
        <TextField
          fkey="address.postalCode"
          id="payout-pin"
          label="PIN code"
          value={values["address.postalCode"]}
          onChange={(v) => set("address.postalCode", v.replace(/\D/g, "").slice(0, 6))}
          register={register}
          error={errors["address.postalCode"]}
          attrs={{ inputMode: "numeric", autoComplete: "postal-code", maxLength: 6 }}
        />
      </Section>

      <Section
        title="Bank account"
        intro="Only Indian bank accounts (INR) can be added. Check the number twice: changing it later goes through our team, not this form."
      >
        <TextField
          fkey="accountNumber"
          id="payout-account"
          label="Bank account number"
          secret
          value={values.accountNumber}
          onChange={(v) => set("accountNumber", v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 20))}
          register={register}
          error={errors.accountNumber}
          attrs={{ autoComplete: "off", autoCapitalize: "characters", spellCheck: false, maxLength: 20 }}
        />
        <TextField
          fkey="confirmAccount"
          id="payout-account-confirm"
          label="Confirm account number"
          secret
          value={confirm}
          onChange={(v) => {
            setConfirm(v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 20));
            setErrors((x) => (x.confirmAccount ? { ...x, confirmAccount: undefined } : x));
          }}
          register={register}
          error={errors.confirmAccount}
          hint="Typed again to catch a slip. It is only compared on this page."
          attrs={{ autoComplete: "off", autoCapitalize: "characters", spellCheck: false, maxLength: 20 }}
        />
        <TextField
          fkey="ifsc"
          id="payout-ifsc"
          label="IFSC code"
          value={values.ifsc}
          onChange={(v) => set("ifsc", v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11))}
          register={register}
          error={errors.ifsc}
          hint="Eleven characters: four letters, a zero, then six letters or digits. It is printed on your cheque book and in your bank's app."
          attrs={{
            autoComplete: "off",
            autoCapitalize: "characters",
            spellCheck: false,
            inputMode: "text",
            maxLength: 11,
            pattern: "[A-Za-z]{4}0[A-Za-z0-9]{6}",
          }}
        />
      </Section>

      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-3 cursor-pointer text-sm text-ink-2 leading-relaxed" htmlFor="payout-consent">
          <input
            ref={register("consent") as (el: HTMLInputElement | null) => void}
            id="payout-consent"
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              setErrors((x) => (x.consent ? { ...x, consent: undefined } : x));
            }}
            aria-invalid={!!errors.consent}
            aria-describedby={errors.consent ? "payout-consent-err" : undefined}
            className="accent-[#403cfa] w-5 h-5 mt-0.5 shrink-0"
          />
          <span>
            I accept the{" "}
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-indigo-light underline underline-offset-2">
              Digital Sukoon creator terms<span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            and{" "}
            <a href="https://razorpay.com/terms/" target="_blank" rel="noopener noreferrer" className="text-indigo-light underline underline-offset-2">
              Razorpay&apos;s terms<span className="sr-only"> (opens in a new tab)</span>
            </a>
            , and I agree that Digital Sukoon sends my PAN, address and bank details to Razorpay to set up my payout account.
          </span>
        </label>
        {errors.consent && <FieldError id="payout-consent-err">{errors.consent}</FieldError>}
      </div>

      {formError && (
        <div ref={bannerRef} tabIndex={-1} className="outline-none">
          <Banner tone="danger" role="alert">
            <p>{formError.text}</p>
            {formError.cleared && <p className="mt-1 text-ink-3">For your safety we cleared the PAN and bank fields. Enter them again.</p>}
          </Banner>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn" disabled={!hydrated || busy} aria-live="polite">
          {busy ? <><span className="spinner" aria-hidden /> Sending to Razorpay…</> : "Add bank account"}
        </button>
        <span className="text-xs text-ink-4 max-w-md">We don&apos;t save what you type here, on this device or on our servers.</span>
      </div>
    </form>
  );
}
