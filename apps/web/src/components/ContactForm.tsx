"use client";

import { useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent } from "react";
// By path, not the @dashmani/shared barrel — the barrel would pull every validator into the bundle.
import { siteEnquirySchema, SITE_ENQUIRY_INTENTS, SITE_ENQUIRY_BUDGETS } from "@dashmani/shared/src/validators/site-enquiry";
import { CONTACT_EMAIL } from "@/lib/content";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.digitalsukoon.com/v1";

type Status = "idle" | "sending" | "sent" | "error";

export default function ContactForm({
  onMagnet,
  onUnmagnet,
}: {
  onMagnet: (e: ReactMouseEvent<HTMLElement>) => void;
  onUnmagnet: (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const [intent, setIntent] = useState<string>(SITE_ENQUIRY_INTENTS[0]);
  const [campaignName, setCampaignName] = useState("");
  const [company, setCompany] = useState("");
  const [budget, setBudget] = useState<string>(SITE_ENQUIRY_BUDGETS[0]);
  const [launchDate, setLaunchDate] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [emailError, setEmailError] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (status === "sending" || status === "sent") return;
    const payload = { intent, campaignName, company, budget, launchDate, email, website };
    const parsed = siteEnquirySchema.safeParse(payload);
    if (!parsed.success) {
      const emailIssue = parsed.error.issues.find((i) => i.path[0] === "email");
      setEmailError(emailIssue ? (email.trim() ? "Enter a valid email address" : "Email is required") : "");
      if (!emailIssue) {
        setStatus("error");
        setMessage("Please check the form and try again.");
      }
      return;
    }
    setEmailError("");
    setStatus("sending");
    setMessage("");
    try {
      const res = await fetch(`${API_URL}/public/enquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.success) {
        setStatus("sent");
        return;
      }
      setStatus("error");
      setMessage(body?.error?.message || "Something went wrong.");
    } catch {
      setStatus("error");
      setMessage("Network error.");
    }
  }

  const label =
    status === "sent" ? "Received. We'll be in touch" : status === "sending" ? "Sending" : "Build my campaign";

  return (
    <form className="contact-form" onSubmit={submit} noValidate>
      <div className="stack-12">
        <p className="kicker" id="intent-label">
          What are you looking to amplify?
        </p>
        <div className="chips" role="group" aria-labelledby="intent-label">
          {SITE_ENQUIRY_INTENTS.map((name) => (
            <button
              key={name}
              type="button"
              className="chip intent-chip"
              aria-pressed={name === intent}
              onClick={() => setIntent(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="fields">
        <label className="field">
          Campaign name
          <input className="input" type="text" name="campaignName" placeholder="Working title" maxLength={200} value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
        </label>
        <label className="field">
          Company
          <input className="input" type="text" name="company" placeholder="Brand, studio or agency" maxLength={200} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="field">
          Budget range
          <select className="input" name="budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
            {SITE_ENQUIRY_BUDGETS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Launch date
          <input className="input" type="date" name="launchDate" value={launchDate} onChange={(e) => setLaunchDate(e.target.value)} />
        </label>
        <label className="field full">
          Email
          <input
            className="input"
            type="email"
            name="email"
            placeholder="name@company.com"
            autoComplete="email"
            required
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "email-error" : undefined}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError("");
            }}
          />
          {emailError && (
            <span id="email-error" className="field-error">
              {emailError}
            </span>
          )}
        </label>
        <label className="honeypot" aria-hidden="true">
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </label>
      </div>
      <button
        type="submit"
        className="btn btn-primary submit"
        disabled={status === "sending"}
        onMouseMove={onMagnet}
        onMouseLeave={onUnmagnet}
      >
        {label} <span aria-hidden="true">→</span>
      </button>
      <p className="form-status" role="status" aria-live="polite">
        {status === "error" && (
          <>
            {message} You can also email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </>
        )}
      </p>
    </form>
  );
}
