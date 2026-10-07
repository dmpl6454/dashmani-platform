"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useProjects } from "@/lib/hooks/use-projects";
import { Plus, Search, FolderOpen, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ModalPortal } from "@/components/modal-portal";

// Mockup palette.
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  ACTIVE:    { label: "Active",    color: "#00D7A0" },
  PAUSED:    { label: "Paused",    color: "#FBBF24" },
  COMPLETED: { label: "Completed", color: "#6EB2FF" },
  ARCHIVED:  { label: "Archived",  color: "#738395" },
};
const STATUS_OPTIONS = ["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"];
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

const GRID = "grid gap-4 items-center [grid-template-columns:minmax(0,2.6fr)_minmax(0,2fr)_minmax(0,.9fr)_minmax(0,1fr)]";
const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const FIELD =
  "h-[38px] px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const EMPTY_FORM = { name: "", description: "", clientId: "", startDate: "", endDate: "" };

function ProjectsInner() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status") || "ACTIVE";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(initialStatus);
  const { data, isLoading, error, mutate } = useProjects({ search, status: status || undefined });
  const projects = (data as any)?.data || [];

  const [newOpen, setNewOpen] = useState(false);
  const [clients, setClients] = useState<any[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!newOpen) return;
    apiFetch("/clients?limit=100").then((res: any) => setClients(res.data || [])).catch(() => setClients([]));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !creating) setNewOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newOpen, creating]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.clientId) {
      setFormError("Project Name and Client required");
      return;
    }
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      setFormError("End date cannot be earlier than start date.");
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          clientId: form.clientId,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
        }),
      });
      mutate();
      setNewOpen(false);
      setForm(EMPTY_FORM);
    } catch (err: any) {
      setFormError(err.message || "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Projects</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {isLoading && !data ? "Loading…" : `${projects.length} project${projects.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setForm(EMPTY_FORM); setFormError(""); setNewOpen(true); }}
          className="inline-flex items-center gap-[7px] h-10 px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold whitespace-nowrap hover:bg-[#F4D58C]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} /> New Project
        </button>
      </section>

      {/* Search + status filter */}
      <section className="flex items-center gap-2.5 flex-wrap">
        <label className="flex items-center gap-2.5 h-[42px] px-4 rounded-full bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_480px] min-w-[220px] max-w-full">
          <Search className="h-[13px] w-[13px] shrink-0" />
          <input
            placeholder="Search projects..."
            aria-label="Search projects"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[12.5px] placeholder:text-ds-t3"
          />
        </label>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status"
          className="h-[42px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] outline-none cursor-pointer [color-scheme:dark] focus:border-ds-gold"
        >
          <option value="" className="bg-ds-card">All Statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s} className="bg-ds-card">{STATUS_CONFIG[s].label}</option>
          ))}
        </select>
      </section>

      {/* Project table */}
      <section className="mt-5 rounded-[12px] border border-[#1D3444] bg-ds-card overflow-hidden shadow-[inset_0_1px_0_rgba(233,189,98,.06),0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className={`${GRID} h-12 px-6 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3`}>
              <span>Project</span><span>Client</span><span>Tasks</span><span>Status</span>
            </div>
            {isLoading && !data ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[64px] px-6 border-b border-[#132430]`}>
                  <div className="flex items-center gap-3.5">
                    <div className="h-10 w-10 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-40 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                  <div className="h-3.5 w-24 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                </div>
              ))
            ) : error ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Projects couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : projects.length === 0 ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                <FolderOpen className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
                No projects found
              </div>
            ) : (
              projects.map((p: any) => {
                const cfg = STATUS_CONFIG[p.status] || STATUS_CONFIG.ARCHIVED;
                const n = p._count?.tasks || 0;
                return (
                  <div key={p.id} className={`${GRID} h-[64px] px-6 border-b border-[#132430] last:border-b-0 hover:bg-[#0A1620] transition-colors`}>
                    <Link href={`/projects/${p.id}`} className="group flex items-center gap-3.5 min-w-0 text-ds-text">
                      <span className="h-10 w-10 rounded-full bg-[rgba(233,189,98,.12)] border border-[rgba(233,189,98,.35)] text-ds-gold grid place-items-center shrink-0">
                        <FolderOpen className="h-[17px] w-[17px]" strokeWidth={1.8} />
                      </span>
                      <span className="text-[14px] font-semibold truncate group-hover:text-ds-gold transition-colors" title={p.name}>{p.name}</span>
                    </Link>
                    <span className="text-[13px] text-ds-t2 truncate" title={p.client?.companyName || undefined}>{p.client?.companyName || "—"}</span>
                    <span className="text-[13px] text-ds-t2 whitespace-nowrap">{n} {n === 1 ? "task" : "tasks"}</span>
                    <span>
                      <span
                        className="inline-flex items-center h-7 px-3.5 rounded-full border text-[12px] font-semibold whitespace-nowrap"
                        style={{ background: rgba(cfg.color, 0.1), borderColor: rgba(cfg.color, 0.3), color: cfg.color }}
                      >
                        {cfg.label}
                      </span>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* New project — slide panel */}
      {newOpen && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex bg-[rgba(2,6,10,.65)]" onClick={() => !creating && setNewOpen(false)}>
              <div className="flex-1" />
              <form
                onSubmit={createProject}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Create New Project"
                className="w-full max-w-[440px] h-full bg-ds-card border-l border-ds-line2 flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,.5)]"
              >
                <div className="flex items-center justify-between h-[57px] px-[22px] border-b border-ds-line shrink-0">
                  <span className="text-[14px] font-semibold text-ds-text">Create New Project</span>
                  <button type="button" onClick={() => setNewOpen(false)} disabled={creating} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-[22px] flex flex-col gap-4">
                  {formError && (
                    <div className="px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px]">{formError}</div>
                  )}
                  <label className={LABEL}>
                    <span>Project Name<span className="text-ds-gold ml-[3px]">*</span></span>
                    <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Q4 Brand Campaign" required className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    <span>Description</span>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Scope, deliverables, notes"
                      className={`${FIELD} h-auto min-h-[84px] py-2.5 resize-y`}
                    />
                  </label>
                  <label className={LABEL}>
                    <span>Client<span className="text-ds-gold ml-[3px]">*</span></span>
                    <select value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required className={`${FIELD} px-2.5 cursor-pointer`}>
                      <option value="" className="bg-ds-card">Select a client</option>
                      {clients.map((c: any) => <option key={c.id} value={c.id} className="bg-ds-card">{c.companyName}</option>)}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className={LABEL}>
                      <span>Start Date</span>
                      <input
                        type="date"
                        value={form.startDate}
                        onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate && form.endDate < e.target.value ? "" : form.endDate })}
                        className={`${FIELD} px-2.5`}
                      />
                    </label>
                    <label className={LABEL}>
                      <span>End Date</span>
                      <input
                        type="date"
                        value={form.endDate}
                        min={form.startDate || undefined}
                        onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                        className={`${FIELD} px-2.5`}
                      />
                    </label>
                  </div>
                </div>
                <div className="flex justify-end gap-2 px-[22px] py-4 border-t border-ds-line shrink-0">
                  <button type="button" onClick={() => setNewOpen(false)} disabled={creating} className="h-9 px-3.5 rounded-[6px] border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text disabled:opacity-50">Cancel</button>
                  <button type="submit" disabled={creating} className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-[#060D14] text-[12px] font-bold hover:bg-[#F4D58C] disabled:opacity-60">
                    {creating ? "Creating..." : "Create Project"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={null}>
      <ProjectsInner />
    </Suspense>
  );
}
