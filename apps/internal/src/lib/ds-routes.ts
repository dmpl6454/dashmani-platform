// Routes that have moved to the premium dark redesign ("ds").
//
// The redesign is rolled out one module at a time. A route listed here renders
// inside the new dark shell (DsSidebar + DsTopNav); every other route keeps the
// classic cream shell untouched, so a page is never shown half-converted (cream
// cards inside a dark frame). Add a module's routes here when its page is done.
//
// DS_EXACT matches only that path. DS_PREFIXES also covers every sub-path
// ("/x" covers "/x/123") — use it only once all of a module's sub-pages are done.
export const DS_EXACT: string[] = ["/employees", "/tasks", "/content", "/accounts", "/accounts/growth", "/daily-reports", "/workload", "/clients", "/projects", "/attendance", "/leave", "/approvals", "/expenses", "/analytics", "/reports", "/reports/link-search", "/reports/links", "/devices", "/complaints", "/bug-reports", "/ai-assistant", "/api-costs", "/offer-letters", "/holidays", "/announcements", "/auto-teams", "/internships", "/jobs", "/settings"];
export const DS_PREFIXES: string[] = ["/dashboard", "/teams", "/campaigns"];

export function isDsRoute(pathname: string): boolean {
  if (DS_EXACT.includes(pathname)) return true;
  return DS_PREFIXES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
