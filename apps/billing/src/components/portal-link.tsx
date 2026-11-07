"use client";
import type { MouseEvent, ReactNode } from "react";
import { openPortal, usePortalUrl, type PortalKey } from "@/lib/portals";

// A link to a page on ANOTHER portal (sales ↔ billing). It is an ordinary <a> whose href is the
// absolute URL (middle-click, copy link and "open in new tab" all work, landing on that portal's
// sign-in with ?next= when the browser has no session there), and a plain left click turns it
// into a handoff so the person arrives already signed in (lib/portals.ts). If the handoff cannot
// be made (offline, no access) the browser follows the href instead.
export function PortalLink({ portal, href, className, title, children, onClick }: {
  portal: PortalKey;
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const abs = usePortalUrl(portal, href);
  async function go(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    try {
      await openPortal(portal, href);
    } catch {
      if (abs) window.location.assign(abs);
    }
  }
  return <a href={abs ?? href} className={className} title={title} onClick={go}>{children}</a>;
}
