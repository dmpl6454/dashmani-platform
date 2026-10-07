"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { AlertCircle, MessageSquare, Send, X } from "lucide-react";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUSES = ["", "OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"];
// Mockup palette.
const STATUS_COLOR: Record<string, string> = { OPEN: "#E9BD62", IN_REVIEW: "#6EB2FF", RESOLVED: "#00D7A0", CLOSED: "#738395" };
const HUES = ["#238BFF", "#E9BD62", "#9B7EDE", "#00D7A0", "#FB7185", "#6EB2FF"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const initials = (name?: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const fdY = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
const FIELD =
  "h-[42px] px-3 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark]";
const Dot = () => <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-[#4A6275] shrink-0" />;

export default function AdminComplaintsPage() {
  usePageTitle("Complaints");
  const [filter, setFilter] = useState("");
  // One request for every status, filtered here so each tab can show its count.
  const { data, error, isLoading, mutate } = useSWR(`/admin/complaints`, (url: string) => apiFetch<any>(url));
  const all: any[] = data?.data || [];
  const complaints = filter ? all.filter((c) => c.status === filter) : all;
  const count = (s: string) => (s ? all.filter((c) => c.status === s).length : all.length);
  const [responding, setResponding] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [responseStatus, setResponseStatus] = useState("RESOLVED");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");

  async function handleRespond(id: string) {
    setSubmitting(true);
    setActionError("");
    try {
      await apiFetch(`/admin/complaints/${id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response, status: responseStatus }),
      });
      setResponding(null);
      setResponse("");
      mutate();
    } catch (e: any) { setActionError(e.message || "Failed to send the response"); }
    setSubmitting(false);
  }

  const openCount = count("OPEN");

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-center justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Employee Complaints</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Review and respond to employee complaints</p>
        </div>
        {openCount > 0 && (
          <span className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.4)] text-ds-gold text-[13px] font-semibold whitespace-nowrap">
            <AlertCircle className="h-[15px] w-[15px]" /> {openCount} Open
          </span>
        )}
      </section>

      {/* Filters */}
      <section className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Status">
          {STATUSES.map((s) => {
            const on = filter === s;
            return (
              <button
                key={s || "all"}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => { setFilter(s); setResponding(null); }}
                className={`inline-flex items-center gap-2 h-9 px-4 rounded-full text-[13px] font-semibold whitespace-nowrap shrink-0 transition-colors ${on ? "bg-ds-gold text-[#060D14]" : "text-ds-t2 hover:text-ds-text"}`}
              >
                {s ? formatStatus(s) : "All"}
                {data && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{count(s)}</span>}
              </button>
            );
          })}
        </div>
        {data && (
          <span className="ml-auto text-[12px] text-ds-t3 whitespace-nowrap">
            {complaints.length} {complaints.length === 1 ? "complaint" : "complaints"}
          </span>
        )}
      </section>

      {actionError && (
        <div className="mt-3.5 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px] flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      <section className="flex flex-col gap-3 mt-[18px]">
        {isLoading && !data ? (
          Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-[150px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)
        ) : error ? (
          <div className="rounded-[16px] border border-[#2A4658] bg-ds-card py-14 px-5 text-center text-[13px] text-ds-t3">
            Complaints couldn&apos;t be loaded just now. Refresh to try again.
          </div>
        ) : complaints.length === 0 ? (
          <div className="rounded-[16px] border border-[#2A4658] bg-ds-card py-14 px-5 flex flex-col items-center gap-3 text-[13px] text-ds-t3">
            <MessageSquare className="h-9 w-9" strokeWidth={1.5} />
            No complaints found
          </div>
        ) : (
          complaints.map((c: any) => {
            const name = c.employee?.name || "—";
            const hue = HUES[hash(name) % HUES.length];
            const sc = STATUS_COLOR[c.status] ?? "#738395";
            const editing = responding === c.id;
            return (
              <article key={c.id} className="rounded-[16px] border border-[#2A4658] bg-ds-card px-6 py-[22px] flex flex-col gap-3.5 overflow-hidden">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0 flex-[1_1_320px]">
                    <span
                      aria-hidden="true"
                      className="h-10 w-10 rounded-full grid place-items-center text-[13px] font-bold shrink-0"
                      style={{ background: rgba(hue, 0.16), color: hue }}
                    >
                      {initials(name)}
                    </span>
                    <div className="min-w-0 leading-[1.3]">
                      <h3 className="text-[16px] font-semibold text-ds-text [text-wrap:pretty] break-words">{c.subject}</h3>
                      <div className="flex items-center gap-2 flex-wrap mt-1 text-[12px] text-ds-t3">
                        <span className="text-ds-t5 font-medium">{name}</span>
                        {c.employee?.email && <span className="break-all">{c.employee.email}</span>}
                        {c.category && (
                          <>
                            <Dot />
                            <span className="inline-flex items-center h-[22px] px-[9px] rounded-full bg-[#0F1F2B] border border-ds-line2 text-ds-t2 text-[11px] font-semibold whitespace-nowrap">
                              {c.category}
                            </span>
                          </>
                        )}
                        <Dot />
                        <span>{fdY(c.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  <span
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap shrink-0"
                    style={{ background: rgba(sc, 0.1), borderColor: rgba(sc, 0.3), color: sc }}
                  >
                    <i className="h-[5px] w-[5px] rounded-full" style={{ background: sc }} />
                    {formatStatus(c.status)}
                  </span>
                </div>

                <p className="sm:pl-[52px] text-[13.5px] leading-[1.6] text-ds-t2 whitespace-pre-wrap break-words [text-wrap:pretty]">{c.description}</p>

                {c.adminResponse && (
                  <div className="sm:ml-[52px] px-3.5 py-3 rounded-[12px] bg-ds-inset border border-ds-line2">
                    <div className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-gold">Your Response</div>
                    <p className="mt-1.5 text-[13px] leading-[1.55] text-[#E3E8EE] whitespace-pre-wrap break-words">{c.adminResponse}</p>
                  </div>
                )}

                {editing ? (
                  <div className="sm:ml-[52px] pt-3.5 border-t border-[#132430] flex flex-col gap-2.5">
                    <textarea
                      placeholder="Type your response..."
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                      rows={3}
                      aria-label="Response"
                      className={`${FIELD} w-full h-auto py-2.5 resize-y`}
                    />
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <select value={responseStatus} onChange={(e) => setResponseStatus(e.target.value)} aria-label="New status" className={`${FIELD} w-[150px] cursor-pointer`}>
                        <option value="IN_REVIEW" className="bg-ds-card">In Review</option>
                        <option value="RESOLVED" className="bg-ds-card">Resolved</option>
                        <option value="CLOSED" className="bg-ds-card">Closed</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRespond(c.id)}
                        disabled={submitting}
                        className="inline-flex items-center gap-2 h-10 px-[18px] rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold hover:bg-[#F4D58C] disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" /> {submitting ? "Sending..." : "Send Response"}
                      </button>
                      <button type="button" onClick={() => { setResponding(null); setResponse(""); }} className="h-10 px-3 text-[13px] font-semibold text-ds-t3 hover:text-ds-text">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="sm:pl-[52px]">
                    <button
                      type="button"
                      onClick={() => { setResponding(c.id); setActionError(""); }}
                      className="inline-flex items-center gap-[7px] h-[34px] px-3.5 rounded-full border border-[rgba(110,178,255,.35)] text-[#6EB2FF] text-[12.5px] font-semibold hover:bg-[rgba(110,178,255,.1)]"
                    >
                      <MessageSquare className="h-[13px] w-[13px]" />
                      {c.adminResponse ? "Update Response" : "Respond"}
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
