import Link from "next/link";

// Branded 404. Rendered inside the root layout (nav + footer + cream theme), so
// this only styles the page body — replacing Next's default black/unstyled 404.
// Shown for a genuinely missing role (bad/expired link); freshly-listed roles no
// longer land here — see resolveJob's fresh-fetch fallback in lib/jobs.ts.
export default function NotFound() {
  return (
    <div className="ds-detail-page ds-notfound">
      <p className="ds-mono ds-notfound-code">Error 404</p>
      <h1 className="ds-notfound-title">We couldn&apos;t find that role.</h1>
      <p className="ds-notfound-lede">
        The link may be out of date, or the position has since been filled.
        Here are the roles we&apos;re hiring for right now.
      </p>
      <div className="ds-notfound-actions">
        <Link className="ds-btn primary" href="/#index">
          See open roles
          <span className="arrow">→</span>
        </Link>
        <Link className="ds-btn ghost" href="/">
          Back to homepage
        </Link>
      </div>
    </div>
  );
}
