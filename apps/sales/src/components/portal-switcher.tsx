"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowUpRight, ExternalLink, LayoutGrid } from "lucide-react";
import { apiFetch, fetcher } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { PortalDirectory } from "@/lib/types";

// Connecting the portals: the sales, staff and HR portals sign in the same account, so a click
// here asks the API for a one-time handoff code and lands the user on the other portal already
// signed in (POST /auth/handoff → <portal>/login#handoff=<code> → POST /auth/handoff/exchange).
// The public sites are plain links. GET /auth/portals is the directory.

export function PortalSwitcher() {
  const { data } = useSWR<PortalDirectory>("/auth/portals", fetcher, { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!data) return null;
  const others = data.portals.filter((p) => p.key !== "sales" && p.access);

  async function go(key: string) {
    setBusy(key);
    setError("");
    try {
      const res = await apiFetch<{ url: string }>("/auth/handoff", { method: "POST", body: JSON.stringify({ target: key }) });
      window.location.assign(res.data.url);
    } catch (err) {
      setError(errorSentence(err, "Couldn't open that portal."));
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" className="btn btn-ghost btn-sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <LayoutGrid size={14} aria-hidden /> <span className="hidden sm:inline">Portals</span>
      </button>
      {open && (
        <div role="menu" aria-label="Other portals" className="absolute right-0 top-full mt-2 w-72 card p-2 z-40 shadow-xl">
          <p className="px-2 pt-1 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-3">Opens signed in</p>
          {others.map((p) => (
            <button key={p.key} type="button" role="menuitem" disabled={busy !== null} onClick={() => go(p.key)} className="w-full flex items-center gap-2 px-2 py-2 text-left hover:bg-muted/60 disabled:opacity-60">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{busy === p.key ? "Opening…" : p.name}</span>
                <span className="block text-xs text-ink-3 truncate">{p.blurb}</span>
              </span>
              <ArrowUpRight size={14} className="text-ink-3 shrink-0" aria-hidden />
            </button>
          ))}
          {others.length === 0 && <p className="px-2 py-2 text-xs text-ink-3">No other portal for this account.</p>}
          <p className="px-2 pt-2 pb-1.5 text-[10px] uppercase tracking-[0.12em] text-ink-3 border-t border-rule mt-1">Public sites</p>
          {data.links.map((l) => (
            <a key={l.key} role="menuitem" href={l.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-2 py-1.5 text-sm text-ink-2 hover:bg-muted/60 hover:text-white">
              <span className="flex-1 truncate">{l.name}</span>
              <ExternalLink size={12} className="text-ink-3 shrink-0" aria-hidden />
            </a>
          ))}
          {error && <p className="px-2 py-1.5 text-xs text-red-400" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
