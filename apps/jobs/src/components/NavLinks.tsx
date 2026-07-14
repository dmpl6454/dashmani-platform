"use client";

import { usePathname } from "next/navigation";
import { smoothScrollToId } from "@/lib/scroll";

// Jobs / Internship nav links with a "you are here" dot on the active section.
// Internship covers /internship; Jobs covers everything else (the listing "/" and
// the individual role pages "/[slug]"), so the dot follows the current page.
export default function NavLinks() {
  const pathname = usePathname();
  const internshipActive = pathname.startsWith("/internship");
  const jobsActive = !internshipActive;

  return (
    <>
      <a
        className="ds-nav-link"
        href="/#index"
        aria-current={jobsActive ? "page" : undefined}
        onClick={(e) => {
          // Already on the homepage: intercept and JS-scroll so it lands exactly on
          // the roles list. Off-homepage: let the browser navigate to /#index normally.
          if (pathname === "/") {
            e.preventDefault();
            smoothScrollToId("index");
          }
        }}
      >
        {jobsActive && <span className="pulse" aria-hidden="true" />}
        Jobs
      </a>
      <a
        className="ds-nav-cta"
        href="/internship"
        aria-current={internshipActive ? "page" : undefined}
      >
        {internshipActive && <span className="pulse" aria-hidden="true" />}
        Internship
      </a>
    </>
  );
}
