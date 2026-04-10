"use client";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { ClipboardList, Save, ChevronLeft, ChevronRight, Check } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const cardClass = "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5";

function formatDate(d: Date) {
  return d.toISOString().split("T")[0];
}

function displayDate(d: Date) {
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export default function PlanOfActionPage() {
  const [date, setDate] = useState(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [tasks, setTasks] = useState("");
  const [achievements, setAchievements] = useState("");
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
        setAchievements(res.data.achievements || "");
        setBlockers(res.data.blockers || "");
        setTomorrowPlan(res.data.tomorrowPlan || "");
      } else {
        setTasks(""); setAchievements(""); setBlockers(""); setTomorrowPlan("");
      }
    } catch {
      setTasks(""); setAchievements(""); setBlockers(""); setTomorrowPlan("");
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
    setSaving(true);
    try {
      await apiFetch("/hr/poa", {
        method: "POST",
        body: JSON.stringify({ date: formatDate(date), tasks, achievements, blockers, tomorrowPlan }),
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

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif flex items-center gap-3">
            <ClipboardList className="h-8 w-8 text-[#F5D547]" /> Plan of Action
          </h1>
          <p className="text-sm text-[#888] mt-1">Update your daily work plan and track progress</p>
        </div>
      </div>

      {/* Date Navigation */}
      <div className="flex items-center gap-4">
        <button onClick={() => changeDate(-1)} className="p-2 rounded-full hover:bg-white border border-[#E8E0D0] transition-colors">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-center flex-1">
          <p className="text-lg font-semibold text-[#1A1A1A]">{displayDate(date)}</p>
          {isToday && <span className="text-xs bg-[#FFF3C4] text-[#B8960C] px-2.5 py-0.5 rounded-full font-medium">Today</span>}
        </div>
        <button onClick={() => changeDate(1)} className="p-2 rounded-full hover:bg-white border border-[#E8E0D0] transition-colors">
          <ChevronRight className="h-4 w-4" />
        </button>
        {!isToday && (
          <button onClick={() => setDate(new Date())} className="text-xs text-blue-600 hover:text-blue-800 font-medium">Go to Today</button>
        )}
      </div>

      {saved && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
          <Check className="h-4 w-4" /> POA saved successfully!
        </div>
      )}

      {/* POA Form */}
      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>
      ) : (
        <form onSubmit={handleSave} className="space-y-5">
          <div className={cardClass}>
            <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">What did you work on today? *</label>
            <textarea value={tasks} onChange={(e) => setTasks(e.target.value)} rows={5} required placeholder="List your tasks and activities for the day..." className={`${inputClass} resize-none`} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className={cardClass}>
              <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">Achievements / Completed</label>
              <textarea value={achievements} onChange={(e) => setAchievements(e.target.value)} rows={3} placeholder="What was completed or achieved..." className={`${inputClass} resize-none`} />
            </div>
            <div className={cardClass}>
              <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">Blockers / Issues</label>
              <textarea value={blockers} onChange={(e) => setBlockers(e.target.value)} rows={3} placeholder="Any blockers or issues faced..." className={`${inputClass} resize-none`} />
            </div>
          </div>

          <div className={cardClass}>
            <label className="block text-sm font-semibold text-[#1A1A1A] mb-2">Plan for Tomorrow</label>
            <textarea value={tomorrowPlan} onChange={(e) => setTomorrowPlan(e.target.value)} rows={3} placeholder="What you plan to work on tomorrow..." className={`${inputClass} resize-none`} />
          </div>

          <div className="flex justify-end">
            <button type="submit" disabled={saving || !tasks.trim()} className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
              <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save POA"}
            </button>
          </div>
        </form>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-[#7A7A7A] uppercase tracking-wider">Recent Updates</h2>
          {history.slice(0, 7).map((poa: any) => {
            const poaDate = new Date(poa.date);
            const isSelected = formatDate(poaDate) === formatDate(date);
            return (
              <button key={poa.id} onClick={() => setDate(poaDate)} className={`w-full text-left ${cardClass} hover:border-[#F5D547] transition-colors ${isSelected ? "border-[#F5D547] bg-[#FEFCF7]" : ""}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-[#1A1A1A]">
                    {poaDate.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}
                  </p>
                  <Check className="h-4 w-4 text-green-600" />
                </div>
                <p className="text-xs text-[#7A7A7A] line-clamp-2">{poa.tasks}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
