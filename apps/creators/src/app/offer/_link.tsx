"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { offerErrorChangesState, offerErrorIsAboutTheLink, offerErrorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { offerPath, platformLabel, safeHref, tidyLink, type OfferDetail, type PostedResponse } from "@/lib/offers";
import { useHydrated } from "@/lib/use-hydrated";
import { Banner, FieldError } from "@/components/ui";
import { windowText } from "@/components/offer-time";

// An accepted offer: post it by hand, then paste the link of the post. The API checks the link against the creator's
// own page and the posting window and answers with a verdict; nothing is final until our team verifies it.
//
// ⚠️ ONLY a loaded answer claims a state. "Link received" is drawn from `offer.link` as the API returned it, never
// from the fact that a request went out. A verdict of "we couldn't find it" invites a second link; "we couldn't check
// automatically" says a person will, and never calls the post wrong.
// No timing is promised anywhere: nothing here says how soon a check, or anything after it, happens.

interface Props {
  offer: OfferDetail;
  /** The API answered with the offer as it now stands (the link and its verdict included). */
  onSent: (next: OfferDetail) => void;
  /** The offer is not in the state the page showed (the posting time ended, it was withdrawn…): re-read it. */
  onStale: () => void;
}

/**
 * Details (of an "unverifiable" check) after which the link they sent can't be compared with their page for a reason that
 * sending the post's own link fixes: a share link names no post, and some link forms can't be compared. The other reasons
 * (Meta busy, a lapsed login, a page that posts too often to reach the post) are not the creator's to fix.
 */
const ASK_FOR_OWN_LINK: ReadonlySet<string> = new Set(["share_link", "link_shape", "feed_shape"]);

/**
 * What the creator is told about the link they sent, by how it was checked. Headline and sentence are ours, picked by the check;
 * the API's sentence is the body, because it already says which case this is (and it carries no timing promise for these checks).
 *
 * ⚠️ `detail` (outside_window / not_found / share_link …) is known only in the answer to the send itself: the offer as it is read
 * later carries the check and the API's sentence, not the detail. So a headline that must differ by detail is used only while
 * the detail is in hand, and the headline for an auto_failed check without it is one that is true of BOTH outcomes ("didn't
 * match a post in your posting window"), so the page never says "couldn't find" about a post that was found.
 */
function verdict(check: string | null, apiMessage: string, platform: string, detail: string | null): { tone: "info" | "warn"; title: string; text: string } {
  switch (check) {
    case "auto_ok":
    case "manual_ok":
      return { tone: "info", title: "Link received — our team is checking it.", text: "We found this post on your page. Our team still has to confirm it." };
    case "unverifiable":
      return {
        tone: detail && ASK_FOR_OWN_LINK.has(detail) ? "warn" : "info",
        title:
          detail === "share_link"
            ? "That link doesn't say which post it is."
            : detail && ASK_FOR_OWN_LINK.has(detail)
              ? "We can't compare this kind of link automatically."
              : "Link received — we couldn't check it automatically.",
        text: apiMessage || "Our team will check this link by hand.",
      };
    case "auto_failed": {
      const outside = detail === "outside_window";
      return {
        tone: "warn",
        title: outside
          ? "We found that post, but it's outside the posting window."
          : detail === "not_found"
            ? "We couldn't find this link on your page."
            : "This link didn't match a post in your posting window.",
        text: apiMessage || `Check that you pasted the link of the post itself, from the ${platform} page you connected, and send it again.`,
      };
    }
    default:
      return { tone: "info", title: "Link received — our team is checking it.", text: "" };
  }
}

export function PostAndLink({ offer, onSent, onStale }: Props) {
  const platform = platformLabel(offer.platform);
  const link = offer.link;
  const canSend = offer.actions.submitLink;
  const failed = link?.check === "auto_failed";
  const dates = windowText(offer.window);

  const hydrated = useHydrated();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  // "Send a different link" is folded away once a link is in, unless that link was not found on the page.
  const [replacing, setReplacing] = useState(false);
  const [justSent, setJustSent] = useState(false);
  // How the link we just sent was judged (the API's `detail`): only the answer to the send carries it, so it is kept here.
  // A reload shows the check and the API's sentence without it, and the form then stays folded behind "Send a different link".
  const [sentDetail, setSentDetail] = useState<string | null>(null);
  const sending = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);

  // After a send the form folds away; the verdict heading takes focus so it is read, not lost.
  useEffect(() => {
    if (justSent) resultRef.current?.focus();
  }, [justSent]);

  const v = link ? verdict(link.check, link.message, platform, sentDetail) : null;
  // A share link (or a link form we can't compare) asks for the post's own link, so the form stays open for it.
  const askForOwnLink = link?.check === "unverifiable" && !!sentDetail && ASK_FOR_OWN_LINK.has(sentDetail);
  const formOpen = canSend && (!link || failed || askForOwnLink || replacing);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!hydrated || busy || sending.current) return;
    const url = tidyLink(value);
    if (url.length < 8) {
      setFieldError("Paste the link of your post.");
      input.current?.focus();
      return;
    }
    if (url.length > 500) {
      setFieldError("That link is too long. Paste the link of the post itself.");
      input.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setFieldError("");
    setFormError("");
    try {
      const r = await apiFetch<PostedResponse>(`${offerPath(offer.id)}/posted`, { method: "POST", body: JSON.stringify({ url }) });
      const { linkResult, ...next } = r.data;
      setValue("");
      setReplacing(false);
      setSentDetail(linkResult?.detail ?? null);
      setJustSent(true);
      onSent(next);
    } catch (err) {
      const text = offerErrorSentence(err, platform);
      if (offerErrorIsAboutTheLink(err)) {
        setFieldError(text);
        input.current?.focus();
      } else {
        setFormError(text);
        if (offerErrorChangesState(err)) onStale();
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  const href = safeHref(link?.url);

  return (
    <section className="card p-5 sm:p-7 flex flex-col gap-5" aria-labelledby="post-title">
      <div>
        <h2 id="post-title" className="text-xl font-extrabold tracking-[-0.03em]">Post it, then send us the link</h2>
        <ol className="mt-3 flex flex-col gap-2 text-sm text-ink-3 leading-relaxed list-decimal pl-5 max-w-2xl">
          <li>Use the files, caption and tags below exactly as given.</li>
          <li>
            Post it on <span className="text-white">{offer.pageName}</span> ({platform}){dates ? <>, between <span className="text-white">{dates}</span> (IST)</> : null}, with the paid-partnership label switched on.
          </li>
          <li>Paste the link of your post here. Our team checks it.</li>
        </ol>
      </div>

      {link && v && (
        <div className="flex flex-col gap-3" role={justSent ? "status" : undefined}>
          <div className="card-inset p-4">
            <p className="field-label">The link you sent</p>
            <p className="mt-1 text-sm break-all">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-light underline underline-offset-2 hover:text-white">{link.url}</a>
              ) : (
                <span className="text-white">{link.url}</span>
              )}
            </p>
            {link.submittedAt && <p className="mt-1 text-xs text-ink-4">Sent {fmtDate(link.submittedAt)}</p>}
          </div>
          <Banner tone={v.tone} title={<span ref={resultRef} tabIndex={-1} className="outline-none">{v.title}</span>}>
            {v.text}
          </Banner>
        </div>
      )}

      {!link && !canSend && (
        <Banner tone="warn" title="The time to send a link has ended.">
          If you did post, email creators@digitalsukoon.com and we&apos;ll look at it with you.
        </Banner>
      )}
      {link && !canSend && !link.verified && (
        <p className="text-sm text-ink-3 leading-relaxed max-w-2xl">The link can&apos;t be changed any more. If it&apos;s wrong, email creators@digitalsukoon.com.</p>
      )}

      {canSend && link && !failed && !askForOwnLink && !replacing && (
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplacing(true); setJustSent(false); }}>Send a different link</button>
        </div>
      )}

      {formOpen && (
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
          <div className="field">
            <label htmlFor="post-link" className="field-label">
              {failed ? "Send another link" : askForOwnLink ? "The post's own link" : replacing ? "A different link" : "Link to your post"}
            </label>
            <input
              ref={input}
              id="post-link"
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="input text-base"
              placeholder={offer.platform === "facebook" ? "https://www.facebook.com/…" : "https://www.instagram.com/…"}
              value={value}
              onChange={(e) => { setValue(e.target.value); if (fieldError) setFieldError(""); }}
              aria-invalid={!!fieldError}
              aria-describedby={`post-link-hint${fieldError ? " post-link-err" : ""}`}
            />
            <span id="post-link-hint" className="text-xs text-ink-4 leading-relaxed">
              Paste the link of the post itself, from your {platform} page.
            </span>
            {fieldError && <FieldError id="post-link-err">{fieldError}</FieldError>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className="btn" disabled={!hydrated || busy}>
              {busy ? <><span className="spinner" aria-hidden /> Sending…</> : link ? "Send this link" : "I've posted it: send the link"}
            </button>
            {replacing && !busy && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplacing(false); setValue(""); setFieldError(""); setFormError(""); }}>Cancel</button>
            )}
          </div>
          {formError && <Banner tone="danger" role="alert">{formError}</Banner>}
        </form>
      )}
      {!formOpen && formError && <Banner tone="danger" role="alert">{formError}</Banner>}
    </section>
  );
}
