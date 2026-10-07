"use client";
import { useEffect, useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { ModalPortal } from "@/components/modal-portal";

const STATUSES = ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW", "OFFERED", "ACCEPTED", "REJECTED"];

const STATUS_COLOR: Record<string, string> = {
  RECEIVED: "#A7B3C2",
  REVIEWING: "#6EB2FF",
  SHORTLISTED: "#9B7EDE",
  INTERVIEW: "#E9BD62",
  OFFERED: "#00D7A0",
  ACCEPTED: "#34D399",
  REJECTED: "#FB7185",
};
const HUES = ["#238BFF", "#E9BD62", "#9B7EDE", "#00D7A0", "#FB7185", "#6EB2FF"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const initials = (name?: string | null) =>
  (name || "").trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
const fdY = (v: string) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
};
const statusColor = (s: string) => STATUS_COLOR[s] ?? "#A7B3C2";

const GRAD = "M22 10L12 5 2 10l10 5 10-5zM6 12v5c3 2 9 2 12 0v-5";
const LINKEDIN = "M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2zM4 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z";
const EXTERNAL = "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6";
const FILE = "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5";
const CLOSE = "M18 6L6 18M6 6l12 12";

function Icon({ d, className = "h-4 w-4", sw = 1.9 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={`${className} shrink-0`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function StatusChip({ status, small = false }: { status: string; small?: boolean }) {
  const c = statusColor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${small ? "h-[26px] px-[11px] text-[11.5px]" : "h-7 px-3 text-[12px]"} rounded-full border font-semibold whitespace-nowrap`}
      style={{ background: rgba(c, 0.1), borderColor: rgba(c, 0.3), color: c }}
    >
      <i className="h-[5px] w-[5px] rounded-full" style={{ background: c }} />
      {status ? formatStatus(status) : "—"}
    </span>
  );
}

const SECTION_LABEL = "text-[10.5px] font-bold tracking-[.12em] uppercase text-ds-t3";

export default function InternshipsPage() {
  usePageTitle("Internships");
  const [filter, setFilter] = useState("");
  const fetcher = (url: string) => apiFetch<any>(url);
  const { data, error, mutate } = useSWR(`/admin/internships${filter ? `?status=${filter}` : ""}`, fetcher);
  // Unfiltered list (same endpoint, same SWR key as the default "All" view) — used only
  // for the header total and the per-status tab counts.
  const { data: allData, mutate: mutateAll } = useSWR("/admin/internships", fetcher, { revalidateOnFocus: false });
  const apps: any[] = data?.data || [];
  const allApps: any[] | null = allData?.data ?? null;
  const [selected, setSelected] = useState<any>(null);
  const [notes, setNotes] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState("");

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !updating) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, updating]);

  async function updateStatus(id: string, status: string) {
    setUpdating(true);
    setUpdateError("");
    try {
      await apiFetch(`/admin/internships/${id}/status`, { method: "POST", body: JSON.stringify({ status, reviewNotes: notes }) });
      mutate();
      if (filter) mutateAll();
      setSelected(null);
      setNotes("");
    } catch (e: any) {
      setUpdateError(e?.message || "Failed to update the status.");
    }
    setUpdating(false);
  }

  function openApp(app: any) {
    setSelected(app);
    setNotes(app.reviewNotes || "");
    setUpdateError("");
  }

  const countFor = (s: string) => (allApps ? (s ? allApps.filter((a) => a.status === s).length : allApps.length) : null);
  const chips = [{ key: "", label: "All" }, ...STATUSES.map((s) => ({ key: s, label: formatStatus(s) }))];

  const hueOf = (a: any) => HUES[hash(a?.name || a?.email || "") % HUES.length];

  const skillsOf = (s: any): string[] =>
    Array.isArray(s) ? s.map(String).filter(Boolean) : typeof s === "string" ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Talent</div>
          <h1 className="mt-1.5 text-[30px] sm:text-[38px] font-extrabold tracking-[-.035em] leading-[1.1] text-ds-text">Internship Applications</h1>
          <p className="mt-2 text-[13.5px] leading-[1.5] text-ds-t2 max-w-[620px] [text-wrap:pretty]">Manage 6-month internship applications</p>
        </div>
        <span className="inline-flex items-center gap-2.5 h-[46px] px-[18px] rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.4)] text-ds-gold text-[13.5px] font-bold whitespace-nowrap">
          <Icon d={GRAD} />
          <span className="text-[20px] font-extrabold tracking-[-.03em] tabular-nums">{countFor("") ?? "—"}</span>
          <span className="text-ds-text">Applications</span>
        </span>
      </section>

      {/* Status filter */}
      <section className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] mb-[18px]" role="tablist" aria-label="Application status">
        {chips.map((c) => {
          const on = filter === c.key;
          const n = countFor(c.key);
          return (
            <button
              key={c.key || "all"}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setFilter(c.key)}
              className={`inline-flex items-center gap-2 h-[38px] px-4 rounded-full border text-[12.5px] font-bold whitespace-nowrap shrink-0 transition-colors ${
                on ? "bg-ds-gold border-ds-gold text-[#060D14]" : "bg-transparent border-ds-line2 text-ds-t2 hover:text-ds-text"
              }`}
            >
              {c.label}
              {n !== null && <span className={`text-[11px] ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{n}</span>}
            </button>
          );
        })}
      </section>

      {/* List */}
      <section className="rounded-[18px] border border-[#2A4658] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.32)] overflow-hidden mb-8">
        {!data && !error ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="grid [grid-template-columns:46px_minmax(0,1fr)_auto] gap-4 items-center px-4 sm:px-6 py-[18px] border-b border-[#132430] last:border-b-0">
              <div className="h-[46px] w-[46px] rounded-full bg-ds-hover motion-safe:animate-pulse" />
              <div className="flex flex-col gap-2">
                <div className="h-3.5 w-48 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                <div className="h-3 w-64 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
              </div>
              <div className="h-7 w-24 rounded-full bg-ds-hover motion-safe:animate-pulse" />
            </div>
          ))
        ) : error && !data ? (
          <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Applications couldn&apos;t be loaded just now. Refresh to try again.</div>
        ) : apps.length === 0 ? (
          <div className="py-14 px-5 flex flex-col items-center gap-2.5 text-ds-t3 text-[13px]">
            <Icon d={GRAD} className="h-8 w-8" sw={1.5} />
            No applications found
          </div>
        ) : (
          apps.map((app: any) => {
            const hue = hueOf(app);
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => openApp(app)}
                className="w-full grid [grid-template-columns:46px_minmax(0,1fr)] sm:[grid-template-columns:46px_minmax(0,1fr)_auto] gap-x-4 gap-y-2 items-center px-4 sm:px-6 py-[18px] border-b border-[#132430] last:border-b-0 bg-transparent text-left hover:bg-[#0A1620] transition-colors"
              >
                <span
                  className="h-[46px] w-[46px] rounded-full grid place-items-center text-[14px] font-extrabold"
                  style={{ background: rgba(hue, 0.16), color: hue }}
                >
                  {initials(app.name)}
                </span>
                <span className="min-w-0 flex flex-col gap-[5px]">
                  <span className="flex items-baseline gap-x-2.5 gap-y-0.5 flex-wrap min-w-0">
                    <span className="text-[15.5px] font-bold text-ds-text [overflow-wrap:anywhere]">{app.name || "—"}</span>
                    <span className="text-[12px] text-ds-t3 [overflow-wrap:anywhere]">{app.email}</span>
                  </span>
                  <span className="flex items-center gap-2 text-[12.5px] text-ds-t2 min-w-0">
                    <Icon d={GRAD} className="h-[13px] w-[13px]" />
                    <span className="[overflow-wrap:anywhere]">
                      {app.college || "—"}
                      {app.course ? ` · ${app.course}` : ""}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 flex-wrap">
                    {app.duration && (
                      <span className="h-[22px] px-[9px] rounded-[7px] bg-[#0F1F2B] border border-[#1F3442] text-ds-t5 text-[11px] font-semibold inline-flex items-center">
                        {app.duration}
                      </span>
                    )}
                    {app.department && (
                      <span className="h-[22px] px-[9px] rounded-[7px] bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.25)] text-ds-gold text-[11px] font-semibold inline-flex items-center">
                        {app.department}
                      </span>
                    )}
                    <span className="text-[11px] text-[#4A6275]">Applied {app.createdAt ? fdY(app.createdAt) : "—"}</span>
                    <span className="sm:hidden"><StatusChip status={app.status} small /></span>
                  </span>
                </span>
                <span className="hidden sm:inline-flex">
                  <StatusChip status={app.status} />
                </span>
              </button>
            );
          })
        )}
      </section>

      {/* Detail drawer */}
      {selected && (() => {
        const hue = hueOf(selected);
        const facts: [string, React.ReactNode][] = [
          ["Email", selected.email ? <a href={`mailto:${selected.email}`} className="text-[#6EB2FF] hover:underline">{selected.email}</a> : "—"],
          ...(selected.phone ? [["Phone", selected.phone] as [string, React.ReactNode]] : []),
          ...(selected.college ? [["College", selected.college] as [string, React.ReactNode]] : []),
          ...(selected.course ? [["Course", selected.course] as [string, React.ReactNode]] : []),
          ["Duration", selected.duration || "—"],
          ...(selected.department ? [["Department", selected.department] as [string, React.ReactNode]] : []),
          ...(selected.startDate ? [["Start Date", fdY(selected.startDate)] as [string, React.ReactNode]] : []),
          ["Applied", selected.createdAt ? fdY(selected.createdAt) : "—"],
        ];
        const skills = skillsOf(selected.skills);
        const links = [
          selected.linkedin && { label: "LinkedIn", fg: "#6EB2FF", d: LINKEDIN, href: selected.linkedin },
          selected.portfolio && { label: "Portfolio", fg: "#9B7EDE", d: EXTERNAL, href: selected.portfolio },
          selected.resumeUrl && {
            label: "Resume",
            fg: "#FB7185",
            d: FILE,
            href: selected.resumeUrl.startsWith("http") ? selected.resumeUrl : `${API_BASE}${selected.resumeUrl}`,
          },
        ].filter(Boolean) as { label: string; fg: string; d: string; href: string }[];
        return (
          <ModalPortal>
            <div className="ds-root contents">
              <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(2,6,10,.6)]" onClick={() => !updating && setSelected(null)}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                  aria-label={selected.name}
                  className="w-full max-w-[540px] h-full flex flex-col bg-ds-card border-l border-ds-line2 shadow-[-24px_0_60px_rgba(0,0,0,.5)]"
                >
                  <div className="px-5 sm:px-7 pt-[26px] pb-5 border-b border-[#1A2C38] flex items-start justify-between gap-3">
                    <div className="flex items-center gap-4 min-w-0">
                      <span
                        className="h-[58px] w-[58px] rounded-full grid place-items-center text-[19px] font-extrabold shrink-0"
                        style={{ background: rgba(hue, 0.16), color: hue }}
                      >
                        {initials(selected.name)}
                      </span>
                      <div className="min-w-0">
                        <h2 className="text-[22px] sm:text-[24px] font-extrabold tracking-[-.03em] leading-[1.15] text-ds-text [overflow-wrap:anywhere]">{selected.name}</h2>
                        <div className="mt-2"><StatusChip status={selected.status} small /></div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected(null)}
                      disabled={updating}
                      aria-label="Close"
                      className="h-9 w-9 rounded-full border border-ds-line2 text-ds-t2 grid place-items-center shrink-0 hover:text-ds-text disabled:opacity-50"
                    >
                      <Icon d={CLOSE} className="h-[15px] w-[15px]" sw={2} />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto px-5 sm:px-7 py-[22px] flex flex-col gap-5">
                    <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2.5">
                      {facts.map(([k, v]) => (
                        <div key={k} className="px-3.5 py-3 rounded-[12px] bg-ds-inset border border-[#1A2C38] min-w-0">
                          <div className={SECTION_LABEL}>{k}</div>
                          <div className="mt-[5px] text-[13px] font-semibold text-ds-text [overflow-wrap:anywhere]">{v}</div>
                        </div>
                      ))}
                    </div>

                    {skills.length > 0 && (
                      <div>
                        <div className={`${SECTION_LABEL} mb-2.5`}>Skills</div>
                        <div className="flex flex-wrap gap-1.5">
                          {skills.map((k, i) => (
                            <span key={`${k}-${i}`} className="h-7 px-3 rounded-full bg-ds-inset border border-ds-line2 text-ds-t5 text-[12px] font-semibold inline-flex items-center">
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {selected.coverLetter && (
                      <div>
                        <div className={`${SECTION_LABEL} mb-2.5`}>Cover Letter</div>
                        <div className="px-[18px] py-4 rounded-[14px] bg-ds-inset border border-[#1A2C38] text-[13.5px] leading-[1.65] text-[#C9D2DC] whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {selected.coverLetter}
                        </div>
                      </div>
                    )}

                    {links.length > 0 && (
                      <div className="flex gap-2 flex-wrap">
                        {links.map((l) => (
                          <a
                            key={l.label}
                            href={l.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 h-[38px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-[12.5px] font-semibold hover:border-[rgba(233,189,98,.5)]"
                            style={{ color: l.fg }}
                          >
                            <Icon d={l.d} className="h-3.5 w-3.5" />
                            {l.label}
                          </a>
                        ))}
                      </div>
                    )}

                    <label className="block">
                      <span className={`${SECTION_LABEL} block mb-2.5`}>Review Notes</span>
                      <textarea
                        placeholder="Review notes..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={3}
                        className="w-full px-[18px] py-3.5 rounded-[16px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] leading-[1.55] outline-none resize-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark]"
                      />
                    </label>
                  </div>

                  <div className="px-5 sm:px-7 pt-4 pb-[22px] border-t border-[#1A2C38] bg-[#0A1620]">
                    {updateError && (
                      <div role="alert" className="mb-3 px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px]">
                        {updateError}
                      </div>
                    )}
                    <div className={`${SECTION_LABEL} mb-2.5`}>Move to</div>
                    <div className="flex flex-wrap gap-2">
                      {STATUSES.filter((s) => s !== selected.status).map((s) => {
                        const c = statusColor(s);
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => updateStatus(selected.id, s)}
                            disabled={updating}
                            className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-full border text-[12px] font-bold whitespace-nowrap transition-[filter] hover:brightness-125 disabled:opacity-50"
                            style={{ background: rgba(c, 0.08), borderColor: rgba(c, 0.35), color: c }}
                          >
                            <i className="h-[5px] w-[5px] rounded-full" style={{ background: c }} />
                            {formatStatus(s)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ModalPortal>
        );
      })()}
    </div>
  );
}
