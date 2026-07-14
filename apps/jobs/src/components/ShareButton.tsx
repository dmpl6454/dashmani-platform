"use client";

import { useState, useRef, useEffect } from "react";
import { SITE_URL } from "@/lib/slug";

interface ShareButtonProps {
  /** URL segment to share — the job's title slug, e.g. "revenue-head". */
  slug: string;
  jobTitle: string;
  /**
   * "icon"    — compact, icon-only; matches `.ds-btn-icon` used beside Save in the
   *             homepage detail panel.
   * "labeled" — icon + "Share" text; matches `.ds-btn ghost` used on the /[id] page.
   */
  variant?: "icon" | "labeled";
  /** Override the icon-variant button class (e.g. "go" to match a list row's arrow). */
  className?: string;
  /** Optional hook so a host with its own toast (the homepage) can surface feedback. */
  onShared?: (message: string) => void;
}

// Shares the DIRECT deep link to one role — `<origin>/<jobId>` — so a recipient lands
// on that exact vacancy instead of the site homepage. On devices with the Web Share
// API (mostly mobile) this opens the native share sheet (WhatsApp, SMS, email…).
// Everywhere else it copies the link to the clipboard and flashes brief "copied"
// feedback on the button itself, so the component works with or without a host toast.
export default function ShareButton({
  slug,
  jobTitle,
  variant = "icon",
  className,
  onShared,
}: ShareButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear the pending reset on unmount so we never setState on a gone component.
  useEffect(() => () => clearTimeout(timer.current), []);

  function flashCopied() {
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  async function handleShare() {
    // Always share the canonical public URL (never the sharer's localhost/preview
    // origin). The path is the readable title slug (e.g. /revenue-head).
    const url = `${SITE_URL}/${slug}`;
    const shareData: ShareData = {
      title: `${jobTitle} — Digital Sukoon Careers`,
      text: `Have a look at this role at Digital Sukoon: ${jobTitle}`,
      url,
    };

    // Web Share API first (mobile-native sheet). Fall through to clipboard on any
    // failure EXCEPT a user-initiated dismissal, which we treat as "nothing to do".
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      flashCopied();
      onShared?.("Link copied — ready to share");
    } catch {
      onShared?.("Couldn't copy the link — try again");
    }
  }

  // Three-node "share" glyph.
  const shareIcon = (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" width="18" height="18">
      <circle cx="15" cy="4.5" r="2.2" />
      <circle cx="5" cy="10" r="2.2" />
      <circle cx="15" cy="15.5" r="2.2" />
      <path d="M13 5.7 7 8.8M7 11.2l6 3.1" />
    </svg>
  );

  const checkIcon = (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" width="18" height="18">
      <path d="m5 10 3.5 3.5L15 6" />
    </svg>
  );

  // stopPropagation so tapping Share inside a clickable row/card doesn't also
  // trigger the row's own navigation.
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleShare();
  };

  if (variant === "labeled") {
    return (
      <button
        type="button"
        className="ds-btn ghost"
        onClick={onClick}
        aria-label={`Share the ${jobTitle} role`}
      >
        {copied ? checkIcon : shareIcon}
        {copied ? "Link copied" : "Share this role"}
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${className ?? "ds-btn-icon"} ${copied ? "saved" : ""}`}
      onClick={onClick}
      aria-label={copied ? "Link copied" : `Share the ${jobTitle} role`}
      title="Share this role"
    >
      {copied ? checkIcon : shareIcon}
    </button>
  );
}
