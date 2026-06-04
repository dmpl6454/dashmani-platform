"use client";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Topstrip } from "@/components/portal-shell";
import { ClipboardList, Save, ChevronLeft, ChevronRight, Check } from "lucide-react";

function formatDate(d: Date) {
  // Use local date parts so the date is correct in IST regardless of UTC offset
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function displayDate(d: Date) {
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export default function PlanOfActionPage() {
  const [date, setDate] = useState(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [tasks, setTasks] = useState("");
  const [blockers, setBlockers] = useState("");
  const [tomorrowPlan, setTomorrowPlan] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    loadPOA(date);
    loadHistory();
  }, [date]);

  async function loadPOA(d: Date) {
    setLoading(true);
    setSaved(false);
    try {
      const res = await apiFetch<any>(`/hr/poa/${formatDate(d)}`);
      if (res.data) {
        setTasks(res.data.tasks || "");
        setBlockers(res.data.blockers || "");
        setTomorrowPlan(res.data.tomorrowPlan || "");
      } else {
        setTasks(""); setBlockers(""); setTomorrowPlan("");
      }
    } catch {
      setTasks(""); setBlockers(""); setTomorrowPlan("");
    }
    setLoading(false);
  }

  async function loadHistory() {
    try {
      const res = await apiFetch<any>("/hr/poa");
      setHistory(res.data || []);
    } catch { setHistory([]); }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tasks.trim()) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (date > today) return;
    setSaving(true);
    try {
      await apiFetch("/hr/poa", {
        method: "POST",
        body: JSON.stringify({ date: formatDate(date), tasks, tomorrowPlan, blockers }),
      });
      setSaved(true);
      loadHistory();
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { alert(e.message); }
    setSaving(false);
  }

  function changeDate(delta: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d);
  }

  const isToday = formatDate(date) === formatDate(new Date());
  const isReadOnly = !isToday;

  const textareaClass = (ro: boolean) =>
    `w-full px-3 py-2.5 text-[13px] font-medium rounded-xl border-2 outline-none transition-colors resize-none ${
      ro
        ? "bg-muted border-ink/5 text-ink-3 cursor-default"
        : "bg-bg border-ink/10 focus:border-indigo text-ink"
    }`;

  return (
    <>
      <Topstrip title="Daily Report" sub="Log what you did today — visible to your admins" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-5">

        {/* Date Navigation — back arrow to browse history; no forward past today */}
        <div className="v3-card-sm flex items-center gap-4">
          <button onClick={() => changeDate(-1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors border border-ink/10">
            <ChevronLeft className="h-4 w-4 text-ink" />
          </button>
          <div className="text-center flex-1">
            <p className="text-[14px] font-semibold text-ink">{displayDate(date)}</p>
            <span className={`inline-flex h-5 px-2.5 rounded-full text-[11px] font-semibold items-center border mt-1 ${
              isToday
                ? "bg-indigo-soft text-indigo border-indigo/20"
                : "bg-muted text-ink-3 border-ink/10"
            }`}>
              {isToday ? "Today" : "Past — view only"}
            </span>
          </div>
          {/* Forward arrow hidden when viewing today — can't go to future */}
          {!isToday ? (
            <button onClick={() => changeDate(1)} className="p-1.5 rounded-lg hover:bg-muted transition-colors border border-ink/10">
              <ChevronRight className="h-4 w-4 text-ink" />
            </button>
          ) : (
            <div className="w-8" />
          )}
          {!isToday && (
            <button onClick={() => { const d = new Date(); d.setHours(0,0,0,0); setDate(d); }} className="text-[12px] text-indigo hover:underline font-semibold whitespace-nowrap">
              Go to Today
            </button>
          )}
        </div>

        {saved && (
          <div className="flex items-center gap-2 bg-success-bg border border-success/20 text-success px-4 py-3 rounded-xl text-[13px] font-medium">
            <Check className="h-4 w-4" /> POA saved successfully!
          </div>
        )}

        {isReadOnly && (
          <div className="flex items-center gap-2 bg-muted border border-ink/10 text-ink-3 px-4 py-3 rounded-xl text-[13px] font-medium">
            <ClipboardList className="h-4 w-4 shrink-0" />
            Past plans are read-only. Navigate to today to submit or update your POA.
          </div>
        )}

        {/* POA Form / View */}
        {loading ? (
          <div className="v3-card flex justify-center py-12">
            <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo" />
          </div>
        ) : (
          <form onSubmit={isReadOnly ? (e) => e.preventDefault() : handleSave} className="space-y-4">
            <div className="v3-card">
              <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <span className="text-[13px] font-semibold text-ink">
                  {isToday ? "What I did today *" : "What was done"}
                </span>
              </div>
              <div className="p-5">
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">
                  {isToday ? "What did you work on?" : "What was worked on"}
                </p>
                <textarea
                  value={tasks}
                  onChange={isReadOnly ? undefined : (e) => setTasks(e.target.value)}
                  readOnly={isReadOnly}
                  rows={5}
                  required={!isReadOnly}
                  placeholder={isReadOnly ? "No tasks recorded." : "List your tasks and activities for the day..."}
                  className={textareaClass(isReadOnly)}
                />
              </div>
            </div>

            <div className="v3-card">
              <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <span className="text-[13px] font-semibold text-ink">Notes</span>
              </div>
              <div className="p-5">
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Anything else worth noting</p>
                <textarea
                  value={blockers}
                  onChange={isReadOnly ? undefined : (e) => setBlockers(e.target.value)}
                  readOnly={isReadOnly}
                  rows={3}
                  placeholder={isReadOnly ? "Nothing recorded." : "Anything that doesn't fit above — issues, context, FYIs..."}
                  className={textareaClass(isReadOnly)}
                />
              </div>
            </div>

            <div className="v3-card">
              <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <span className="text-[13px] font-semibold text-ink">Tomorrow's Plan</span>
              </div>
              <div className="p-5">
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">What's next?</p>
                <textarea
                  value={tomorrowPlan}
                  onChange={isReadOnly ? undefined : (e) => setTomorrowPlan(e.target.value)}
                  readOnly={isReadOnly}
                  rows={3}
                  placeholder={isReadOnly ? "Nothing recorded." : "What you plan to work on tomorrow..."}
                  className={textareaClass(isReadOnly)}
                />
              </div>
            </div>

            {!isReadOnly && (
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={saving || !tasks.trim()}
                  className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50"
                >
                  <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save POA"}
                </button>
              </div>
            )}
          </form>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Past Plans</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {history.slice(0, 10).map((poa: any) => {
                const poaDate = new Date(poa.date);
                const isSelected = formatDate(poaDate) === formatDate(date);
                return (
                  <button
                    key={poa.id}
                    onClick={() => setDate(poaDate)}
                    className={`v3-row w-full text-left px-4 py-3 rounded-xl transition-colors ${isSelected ? "bg-indigo-soft" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[13px] font-semibold text-ink">
                        {poaDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                      </p>
                      <Check className="h-3.5 w-3.5 text-success" />
                    </div>
                    <p className="text-[12px] text-ink-3 line-clamp-1">{poa.tasks}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
