/**
 * Sent as `clientBuild` on every /sync. Bump it whenever the sync protocol changes
 * incompatibly; the server answers `reload:true` below `pipeline.minClientBuild` (§9.9).
 */
export const PIPELINE_CLIENT_BUILD = 1;

/** z-scale (spec §9.10): header 20, mobile bar 40, phone project surface 45, sheets 50,
 * mention popover 56, toasts 57, drag overlay 60. */
export const Z = { header: 20, phoneSurface: 45, sheet: 50, mention: 56, toast: 57, drag: 60 } as const;
