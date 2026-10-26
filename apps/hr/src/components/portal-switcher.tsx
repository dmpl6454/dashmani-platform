"use client";
import { useState } from "react";
import useSWR from "swr";
import { ArrowUpRight, Briefcase, ExternalLink, LayoutGrid } from "lucide-react";
import { apiFetch } from "@/lib/api";

// Connecting the portals: the HR, staff and sales portals sign in the same account, so an entry
// here asks the API for a one-time handoff code and lands the user on the other portal already
// signed in (POST /auth/handoff → <portal>/login#handoff=<code> → POST /auth/handoff/exchange).
// GET /auth/portals says which portals this account may enter (Sales needs the Sales or Admin
// role). Rendered in the sidebar footer (hr-sidebar.tsx), above Collapse; icons only when collapsed.

interface Entry { key: "internal" | "hr" | "sales"; name: string; blurb: string; url: string; access: boolean }
interface Directory { portals: Entry[]; links: Array<{ key: string; name: string; blurb: string; url: string }> }

const unwrap = <T,>(r: any): T => (r && typeof r === "object" && "data" in r ? r.data : r);
const fetcher = (p: string) => apiFetch<any>(p).then((r) => unwrap<Directory>(r));

export function PortalSwitcherRail({ expanded }: { expanded: boolean }) {
  const { data } = useSWR<Directory>("/auth/portals", fetcher, { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!data?.portals) return null;
  const others = data.portals.filter((p) => p.key !== "hr" && p.access);

  async function open(key: string) {
    setBusy(key);
    setError("");
    try {
      const res = unwrap<{ url: string }>(await apiFetch<any>("/auth/handoff", { method: "POST", body: JSON.stringify({ target: key }) }));
      window.location.assign(res.url);
    } catch (err: any) {
      setError(err?.message || "Couldn't open that portal.");
      setBusy(null);
    }
  }

  return (
    <div className="pb-1 mb-1" style={{ borderBottom: "1px dashed rgba(26,26,26,0.1)" }}>
      {expanded && <p className="px-3 pt-0.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-ink-4">Other portals</p>}
      {others.map((p) => (
        <button
          key={p.key}
          type="button"
          disabled={busy !== null}
          onClick={() => open(p.key)}
          title={expanded ? p.blurb : `${p.name} — opens signed in`}
          className={`w-full flex items-center ${expanded ? "gap-2 px-3" : "justify-center px-0"} h-9 rounded-xl text-[12.5px] font-medium text-ink-2 hover:bg-muted/80 hover:text-ink transition-colors disabled:opacity-60`}
        >
          {p.key === "sales" ? <Briefcase size={15} /> : <LayoutGrid size={15} />}
          {expanded && <span className="flex-1 text-left truncate">{busy === p.key ? "Opening…" : p.name}</span>}
          {expanded && <ArrowUpRight size={13} className="text-ink-4" />}
        </button>
      ))}
      {expanded && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pt-1">
          {data.links.map((l) => (
            <a key={l.key} href={l.url} target="_blank" rel="noopener noreferrer" title={l.blurb} className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-4 hover:text-indigo transition-colors">
              {l.name}<ExternalLink size={11} />
            </a>
          ))}
        </div>
      )}
      {error && expanded && <p className="px-3 pt-1 text-[11px] text-[#E74C3C]">{error}</p>}
    </div>
  );
}
