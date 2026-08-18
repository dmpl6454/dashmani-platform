"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { smoothScrollToId } from "@/lib/scroll";

// Jobs / Internship nav links with a "you are here" dot on the active section.
// Internship covers /internship; Jobs covers everything else (the listing "/" and
// the individual role pages "/[slug]"), so the dot follows the current page.
//
// These MUST be next/link, not plain <a href>. A raw anchor tears down the document and
// loads the target from scratch, which resets the `window.__dsJobsLoaderPlayed` /
// `window.__dsEntryPath` flags that JobsClient uses to decide whether to play the hero
// preloader (see the comment block there). The visible symptom: go to /internship, click
// back to Jobs, and the full-page liquid loader replays even though the visitor never
// refreshed — because as far as the browser was concerned, they did. Client-side
// transitions keep the document (and those flags) alive, so the loader plays only on a
// genuine load or refresh. next/link still renders a real crawlable <a href>, so nothing
// about SEO changes.
export default function NavLinks() {
  const pathname = usePathname();
  const internshipActive = pathname.startsWith("/internship");
  const jobsActive = !internshipActive;

  return (
    <>
      <Link
        className="ds-nav-link"
        href="/#index"
        aria-current={jobsActive ? "page" : undefined}
        onClick={(e) => {
          // Already on the homepage: intercept and JS-scroll so it lands exactly on
          // the roles list. Off-homepage: let Next route to "/" and handle the hash.
          if (pathname === "/") {
            e.preventDefault();
            smoothScrollToId("index");
          }
        }}
      >
        {jobsActive && <span className="pulse" aria-hidden="true" />}
        Jobs
      </Link>
      <Link
        className="ds-nav-cta"
        href="/internship"
        aria-current={internshipActive ? "page" : undefined}
      >
        {internshipActive && <span className="pulse" aria-hidden="true" />}
        Internship
      </Link>
    </>
  );
}
