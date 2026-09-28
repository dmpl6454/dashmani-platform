/**
 * Every deploy wipes `.next`, so a tab opened before it can fail to load a chunk. Reload
 * ONCE (guarded by sessionStorage) — never a loop (spec §9.9).
 */
const KEY = "pl-chunk-reload-at";

export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  if (!e) return false;
  if (e.name === "ChunkLoadError") return true;
  const m = String(e.message ?? "");
  return m.includes("Loading chunk") || m.includes("Loading CSS chunk") || m.includes("dynamically imported module");
}

/** Reload once per 10 minutes for a chunk error. Returns true when a reload was started. */
export function reloadOnceForChunkError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 10 * 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
