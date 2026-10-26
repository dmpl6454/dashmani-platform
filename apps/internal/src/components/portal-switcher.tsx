"use client";
import { useState } from "react";
import useSWR from "swr";
import { ArrowUpRight, Briefcase, ExternalLink, Users } from "lucide-react";
import { cn } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

// Connecting the portals: the staff portal, HR and Sales sign in the same account, so a click
// here asks the API for a one-time handoff code and lands the user on the other portal already
// signed in (POST /auth/handoff → <portal>/login#handoff=<code> → POST /auth/handoff/exchange).
// The public sites are plain links. The directory comes from GET /auth/portals, which also says
// which portals this account may enter (Sales needs the Sales or Admin role). Rendered at the
// foot of the DS rail (components/ds/ds-sidebar.tsx), above Collapse; icons only when collapsed.

interface Entry { key: "internal" | "hr" | "sales"; name: string; blurb: string; url: string; access: boolean }
interface Directory { portals: Entry[]; links: Array<{ key: string; name: string; blurb: string; url: string }> }

const fetcher = (p: string) => apiFetch<{ data: Directory }>(p).then((r) => r.data);
const ICONS = { hr: Users, sales: Briefcase, internal: ArrowUpRight } as const;

export function PortalSwitcher({ collapsed }: { collapsed: boolean }) {
  const { data } = useSWR<Directory>("/auth/portals", fetcher, { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!data) return null;
  const others = data.portals.filter((p) => p.key !== "internal" && p.access);

  async function open(key: string) {
    setBusy(key);
    setError("");
    try {
      const res = await apiFetch<{ data: { url: string } }>("/auth/handoff", { method: "POST", body: JSON.stringify({ target: key }) });
      window.location.assign(res.data.url);
    } catch (err: any) {
      setError(err?.message || "Couldn't open that portal.");
      setBusy(null);
    }
  }

  return (
    <div className={cn("shrink-0 border-t border-ds-line", collapsed ? "px-2 py-2" : "px-2 pt-1 pb-2")}>
      {!collapsed && <p className="px-[13px] pt-2 pb-1 text-[10px] font-semibold tracking-[.12em] uppercase text-ds-t4">Switch portal</p>}
      <div className="flex flex-col gap-0.5">
        {others.map((p) => {
          const Icon = ICONS[p.key];
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => open(p.key)}
              disabled={busy !== null}
              title={collapsed ? undefined : p.blurb}
              className={cn(
                "group relative flex items-center h-9 rounded-[6px] border border-transparent text-[13px] font-medium text-ds-t2 transition-colors hover:bg-ds-gold/[.08] hover:text-ds-text disabled:opacity-60",
                collapsed ? "justify-center px-0" : "gap-3 px-[13px] w-full text-left",
              )}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
              {!collapsed && <span className="flex-1 truncate">{busy === p.key ? "Opening…" : p.name}</span>}
              {!collapsed && <ArrowUpRight className="h-3.5 w-3.5 text-ds-t4" />}
              {collapsed && (
                <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 transition-opacity px-2.5 py-1 rounded-[6px] bg-ds-inset border border-ds-line2 text-ds-text text-xs font-medium whitespace-nowrap shadow-lg">
                  {p.name} · opens signed in
                </span>
              )}
            </button>
          );
        })}
      </div>
      {!collapsed && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 px-[13px]">
          {data.links.map((l) => (
            <a key={l.key} href={l.url} target="_blank" rel="noopener noreferrer" title={l.blurb} className="inline-flex items-center gap-1 text-[11px] font-medium text-ds-t4 transition-colors hover:text-ds-gold">
              {l.name}<ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>
      )}
      {error && !collapsed && <p className="mt-1 px-[13px] text-[11px] text-ds-redsoft">{error}</p>}
    </div>
  );
}
