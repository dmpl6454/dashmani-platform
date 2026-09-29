import type { PipelineDirectoryEntry } from "@dashmani/shared";

/**
 * Local directory filter (spec §9.6, §9.7): pickable users only, name PREFIX matches
 * first, then substring, preferred ids (e.g. participants) first within each group.
 * Zero requests per keystroke.
 */
export function filterPeople(
  dir: readonly PipelineDirectoryEntry[],
  query: string,
  opts: { exclude?: ReadonlySet<string>; prefer?: ReadonlySet<string>; limit?: number } = {},
): PipelineDirectoryEntry[] {
  const q = query.trim().toLowerCase();
  const limit = opts.limit ?? 8;
  const prefix: PipelineDirectoryEntry[] = [];
  const sub: PipelineDirectoryEntry[] = [];
  for (const d of dir) {
    if (!d.pickable || opts.exclude?.has(d.id)) continue;
    const name = d.name.toLowerCase();
    if (!q) prefix.push(d);
    else if (name.startsWith(q) || name.split(" ").some((w) => w.startsWith(q))) prefix.push(d);
    else if (name.includes(q)) sub.push(d);
  }
  const rank = (a: PipelineDirectoryEntry, b: PipelineDirectoryEntry) => {
    const pa = opts.prefer?.has(a.id) ? 0 : 1;
    const pb = opts.prefer?.has(b.id) ? 0 : 1;
    return pa - pb || a.name.localeCompare(b.name);
  };
  prefix.sort(rank);
  sub.sort(rank);
  return [...prefix, ...sub].slice(0, limit);
}
