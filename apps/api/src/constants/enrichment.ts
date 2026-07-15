// Shared system_settings key for the entity-extraction admin kill-switch.
// Read by entity-extraction.cron.ts (runEntityExtraction's gate) and
// read/written by GET+PUT /admin/enrichment/toggle in admin-reports.routes.ts.
// Kept in one place so the two independent call sites can never drift apart on
// the literal string (a typo in either would silently make the toggle inert).
export const ENRICHMENT_ENABLED_KEY = "enrichment.enabled";

// system_settings key: hard USD ceiling on DeepSeek extraction spend PER UTC DAY.
// Read by the extraction cron (skips the run once today's spend hits it) and
// read/written by GET+PUT /admin/extraction/spend-ceiling. A hard cap independent of
// the DeepSeek prepaid balance — the last line of defense against overspend.
export const EXTRACTION_SPEND_CEILING_KEY = "extraction.spendCeilingUsd";
export const DEFAULT_EXTRACTION_SPEND_CEILING_USD = 3;
