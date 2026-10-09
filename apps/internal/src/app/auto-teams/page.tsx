"use client";
import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { X } from "lucide-react";

const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const PLAT: Record<string, string> = {
  instagram: "var(--hx-E1306C)",
  linkedin: "var(--hx-0A66C2)",
  youtube: "var(--hx-E5484D)",
  facebook: "var(--hx-1877F2)",
  x: "var(--hx-3A4B5A)",
  twitter: "var(--hx-3A4B5A)",
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const initials = (name?: string | null) =>
  (name || "").trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
const kfmt = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(v);
};
const imgSrc = (u: string) => (u.startsWith("http") ? u : `${API_BASE}${u}`);

const USERS = "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8";
const USER_PLUS = "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6";
const CHECK = "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3";

function Icon({ d, className = "h-4 w-4", sw = 2 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={`${className} shrink-0`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export default function AutoTeamsPage() {
  const { data, isLoading, error, mutate } = useSWR("/admin/auto-teams", (url: string) => apiFetch<any>(url));
  const sharedAccounts = data?.data || [];
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  async function createTeam(account: any) {
    const name = (teamNames[account.accountId] || "").trim();
    if (!name) return;
    setSubmitting(account.accountId);
    setErrorMsg("");
    try {
      await apiFetch("/admin/auto-teams/create", {
        method: "POST",
        body: JSON.stringify({
          name,
          accountId: account.accountId,
          memberIds: account.members.map((m: any) => m.id),
        }),
      });
      setSuccessMsg(`Team "${name}" created with ${account.members.length} members!`);
      setTeamNames((prev) => ({ ...prev, [account.accountId]: "" }));
      setSubmitting(null);
      mutate();
      setTimeout(() => setSuccessMsg(""), 4000);
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to create the team.");
      setSubmitting(null);
    }
  }

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Teams</div>
          <h1 className="mt-1.5 text-[30px] sm:text-[38px] font-extrabold tracking-[-.035em] leading-[1.1] text-ds-text">Auto-Detected Teams</h1>
          <p className="mt-2 text-[13.5px] leading-[1.5] text-ds-t2 max-w-[620px] [text-wrap:pretty]">
            Employees working on the same social accounts are automatically grouped. Create teams from these groups.
          </p>
        </div>
        <span className="inline-flex items-center gap-2.5 h-[46px] px-[18px] rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.4)] text-ds-gold text-[13.5px] font-bold whitespace-nowrap">
          <Icon d={USERS} sw={1.9} />
          <span className="text-[20px] font-extrabold tracking-[-.03em] tabular-nums">{data ? sharedAccounts.length : "—"}</span>
          <span className="text-ds-text">Shared Accounts</span>
        </span>
      </section>

      {successMsg && (
        <section role="status" className="flex items-center gap-2.5 mb-4 px-[18px] py-3.5 rounded-[14px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.35)] text-ds-teal text-[13.5px] font-semibold">
          <Icon d={CHECK} />
          {successMsg}
        </section>
      )}

      {errorMsg && (
        <div role="alert" className="mb-4 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] flex items-center justify-between gap-3">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      {isLoading ? (
        <section className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[360px] rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card motion-safe:animate-pulse" />
          ))}
        </section>
      ) : error && !data ? (
        <section className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card py-14 px-5 text-center text-ds-t3 text-[13px]">
          Shared accounts couldn&apos;t be loaded just now. Refresh to try again.
        </section>
      ) : sharedAccounts.length === 0 ? (
        <section className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] py-16 px-5 flex flex-col items-center gap-2.5 text-center text-ds-t3 text-[13px]">
          <Icon d={USERS} className="h-9 w-9" sw={1.5} />
          <span className="text-[14.5px] font-semibold text-ds-text">No shared accounts found</span>
          Teams will appear here when multiple employees are assigned to the same account
        </section>
      ) : (
        <section className="grid gap-4 mb-8 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
          {sharedAccounts.map((account: any) => {
            const platform: string = account.platform || "";
            const pc = PLAT[platform.toLowerCase()] || "var(--hx-E9BD62)";
            const members: any[] = account.members || [];
            const busy = submitting === account.accountId;
            const value = teamNames[account.accountId] ?? "";
            const hueOf = (m: any) => HUES[hash(m.name || m.email || m.id || "") % HUES.length];
            return (
              <div key={account.accountId} className="rounded-[18px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] flex flex-col overflow-hidden min-w-0">
                {/* Account header */}
                <div
                  className="px-[22px] pt-[22px] pb-5 border-b border-[color:var(--hx-1A2C38)] flex items-center gap-3.5"
                  style={{ background: `linear-gradient(135deg, ${rgba(pc, 0.16)}, transparent 70%)` }}
                >
                  <span
                    className="h-12 w-12 rounded-[14px] grid place-items-center text-white text-[20px] font-extrabold shrink-0"
                    style={{ background: pc, boxShadow: `0 8px 20px ${rgba(pc, 0.35)}` }}
                  >
                    {platform[0]?.toUpperCase() || "?"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[17px] font-extrabold tracking-[-.02em] text-ds-text [overflow-wrap:anywhere]">
                      {account.displayName || account.handle || "—"}
                    </div>
                    <div className="mt-1 text-[12px] text-ds-t2 [overflow-wrap:anywhere]">
                      {platform || "—"} · @{account.handle}
                      {account.clientName ? ` · ${account.clientName}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[22px] font-extrabold tracking-[-.03em] leading-none tabular-nums text-ds-text">{kfmt(account.followerCount)}</div>
                    <div className="mt-[5px] text-[10px] font-bold tracking-[.14em] uppercase text-ds-t3">Followers</div>
                  </div>
                </div>

                {/* Member label + stack */}
                <div className="px-[22px] pt-4 pb-2 flex items-center justify-between gap-2.5">
                  <span className="text-[11px] font-bold tracking-[.14em] uppercase text-ds-t3">{members.length} Team Members</span>
                  <span className="flex pl-2">
                    {members.slice(0, 4).map((m: any) => (
                      <span
                        key={m.id}
                        className="h-7 w-7 -ml-2 rounded-full border-2 border-ds-card grid place-items-center text-[10px] font-extrabold text-[color:var(--hx-060D14)]"
                        style={{ background: rgba(hueOf(m), 0.9) }}
                      >
                        {initials(m.name)}
                      </span>
                    ))}
                  </span>
                </div>

                {/* Members */}
                <div className="px-3 pb-3 flex flex-col">
                  {members.map((member: any) => {
                    const hue = hueOf(member);
                    return (
                      <div key={member.id} className="flex items-center gap-3 p-2.5 rounded-[12px] hover:bg-ds-inset transition-colors">
                        {member.profileImageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={imgSrc(member.profileImageUrl)} alt="" className="h-9 w-9 rounded-full object-cover shrink-0" />
                        ) : (
                          <span
                            className="h-9 w-9 rounded-full grid place-items-center text-[12px] font-extrabold shrink-0"
                            style={{ background: rgba(hue, 0.16), color: hue }}
                          >
                            {initials(member.name)}
                          </span>
                        )}
                        <span className="flex-1 min-w-0 leading-[1.3]">
                          <span className="block text-[13.5px] font-semibold text-ds-text truncate">{member.name || "—"}</span>
                          <span className="block text-[11.5px] text-ds-t3 truncate">{member.email || "—"}</span>
                        </span>
                        {member.currentTeam && (
                          <span className="h-6 px-2.5 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[11px] font-semibold inline-flex items-center whitespace-nowrap shrink-0 max-w-[45%] truncate">
                            {member.currentTeam}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Create team */}
                <div className="mt-auto px-[22px] pt-4 pb-5 border-t border-[color:var(--hx-1A2C38)] bg-[color:var(--hx-0A1620)] flex gap-2.5 flex-wrap">
                  <input
                    type="text"
                    aria-label={`Team name for ${account.displayName || account.handle}`}
                    placeholder={`Team name (e.g., "${account.handle} Team")`}
                    value={value}
                    onFocus={() => {
                      if (!teamNames[account.accountId])
                        setTeamNames((prev) => ({ ...prev, [account.accountId]: `${account.displayName || account.handle} Team` }));
                    }}
                    onChange={(e) => setTeamNames((prev) => ({ ...prev, [account.accountId]: e.target.value }))}
                    className="flex-[1_1_180px] min-w-0 h-[46px] px-[18px] rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark]"
                  />
                  <button
                    type="button"
                    onClick={() => createTeam(account)}
                    disabled={busy || !value.trim()}
                    className="inline-flex items-center justify-center gap-2 h-[46px] px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-50 disabled:hover:bg-ds-gold"
                  >
                    <Icon d={USER_PLUS} className="h-[15px] w-[15px]" />
                    {busy ? "Creating..." : "Create Team"}
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
