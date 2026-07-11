// Shared system_settings key for the entity-extraction admin kill-switch.
// Read by entity-extraction.cron.ts (runEntityExtraction's gate) and
// read/written by GET+PUT /admin/enrichment/toggle in admin-reports.routes.ts.
// Kept in one place so the two independent call sites can never drift apart on
// the literal string (a typo in either would silently make the toggle inert).
export const ENRICHMENT_ENABLED_KEY = "enrichment.enabled";
