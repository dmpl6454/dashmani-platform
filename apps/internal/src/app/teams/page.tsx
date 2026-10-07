"use client";
// Teams — premium dark redesign ("ds"), built to the Teams.dc.html mockup.
// UI only: the same /teams endpoints for create, delete, bulk delete, add member,
// add-to-another-team and remove-from-team as before.
import { useState } from "react";
import useSWR from "swr";
import { Building2, Users, Plus, Trash2, UserPlus, UserMinus, ArrowRightLeft, ChevronRight, Check, X } from "lucide-react";
import { apiFetch, API_BASE } from "@/lib/api";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { toTitleCase } from "@dashmani/shared";

const TYPES: Record<string, { label: string; color: string; icon: any }> = {
  DEPARTMENT: { label: "Department", color: "#E9BD62", icon: Building2 },
  TEAM: { label: "Team", color: "#238BFF", icon: Users },
  SUB_TEAM: { label: "Sub team", color: "#00D7A0", icon: Users },
};
const STATUS: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: "Active", color: "#00D7A0" },
  ONBOARDING: { label: "Onboarding", color: "#FBBF24" },
  INACTIVE: { label: "Inactive", color: "#738395" },
};
const AV_BG = ["#10222E", "#0E2A22", "#1B1630", "#2A2410", "#2A1116"];
const AV_FG = ["#238BFF", "#34D399", "#9B7EDE", "#E9BD62", "#FB7185"];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const fieldLabel = "flex flex-col gap-1.5 text-[10.5px] text-ds-t3 font-semibold tracking-[.08em] uppercase";
const fieldInput = "h-9 px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[12.5px] normal-case tracking-normal font-normal outline-none";
const ghostBtn = "h-9 px-3.5 rounded-[6px] border border-ds-line2 bg-transparent text-ds-t2 text-[12px] font-semibold transition-colors hover:text-ds-text hover:border-ds-line4";
const goldBtn = "h-9 px-4 rounded-[6px] bg-ds-gold text-ds-bg text-[12px] font-bold transition-colors hover:bg-ds-gold2 disabled:opacity-50";
const iconBtn = "h-7 w-7 rounded-[6px] border border-ds-line2 bg-transparent text-ds-t2 grid place-items-center transition-colors";

function Avatar({ name, url, size }: { name: string; url?: string | null; size: number }) {
  const h = hash(name || "");
  const src = url ? (url.startsWith("http") ? url : `${API_BASE}${url}`) : null;
  const dim = { width: size, height: size };
  return src ? (
    <img src={src} alt="" style={dim} className="rounded-full object-cover border border-ds-line2 shrink-0" />
  ) : (
    <span style={{ ...dim, background: AV_BG[h % 5], color: AV_FG[h % 5], fontSize: size * 0.4 }} className="rounded-full border border-ds-line2 grid place-items-center font-bold shrink-0">
      {(name || "?").charAt(0).toUpperCase()}
    </span>
  );
}

function Modal({ title, sub, onClose, children }: { title: string; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-[380px] rounded-[10px] border border-ds-line2 bg-ds-card p-[22px] shadow-[0_20px_50px_rgba(0,0,0,.6)]" onClick={(e) => e.stopPropagation()}>
        <p className="text-[14px] font-semibold text-ds-text">{title}</p>
        {sub && <p className="text-[11px] text-ds-t3 mt-1">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export default function TeamsPage() {
  usePageTitle("Teams");
  const { data: teamsData, mutate, isLoading } = useSWR("/teams", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  // limit:500 — the "Add Member" dropdown must list ALL employees. Without it the
  // API caps at 50 (sorted by name), silently hiding everyone past ~rank 50.
  const { data: employeesData } = useEmployees({ limit: 500 });

  const teams = (teamsData as any)?.data ?? [];
  const employees = (employeesData as any)?.data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "TEAM" as string, parentId: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [assignModal, setAssignModal] = useState<{ teamId: string; teamName: string } | null>(null);
  const [assignEmployeeId, setAssignEmployeeId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [moveModal, setMoveModal] = useState<{ memberId: string; memberName: string } | null>(null);
  const [moveTargetTeamId, setMoveTargetTeamId] = useState("");

  function flatUnits(units: any[]): any[] {
    return units.flatMap((u: any) => [u, ...flatUnits(u.children ?? [])]);
  }
  const allUnits = flatUnits(teams);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch("/teams", {
        method: "POST",
        body: JSON.stringify({ name: form.name, type: form.type, parentId: form.parentId || undefined }),
      });
      setForm({ name: "", type: "TEAM", parentId: "" });
      setCreateOpen(false);
      mutate();
    } catch (err: any) {
      setCreateError(err.message || "Failed to create team");
    } finally { setCreating(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this team? Members will be unassigned.")) return;
    setActionError(null);
    try {
      await apiFetch(`/teams/${id}`, { method: "DELETE" });
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      mutate();
    } catch (err: any) { setActionError(err.message || "Couldn't delete the team."); }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (!confirm(`Delete ${ids.length} team(s)? All members will be unassigned.`)) return;
    setBulkDeleting(true);
    setActionError(null);
    try {
      await apiFetch("/teams/bulk", { method: "DELETE", body: JSON.stringify({ ids }) });
      setSelected(new Set());
      mutate();
    } catch (err: any) { setActionError(err.message || "Couldn't delete the selected teams."); }
    finally { setBulkDeleting(false); }
  }

  async function handleAssign() {
    if (!assignModal || !assignEmployeeId) return;
    setActionError(null);
    try {
      // Additive: adds the person to this team WITHOUT removing them from any
      // other team they already belong to (POST creates a membership row).
      await apiFetch(`/teams/${assignModal.teamId}/members`, { method: "POST", body: JSON.stringify({ userId: assignEmployeeId }) });
      setAssignModal(null);
      setAssignEmployeeId("");
      mutate();
    } catch (err: any) { setActionError(err.message || "Couldn't add the member."); }
  }

  // Removes the member from THIS team only — leaves their other teams intact.
  async function handleRemoveMember(teamId: string, memberId: string) {
    setActionError(null);
    try {
      await apiFetch(`/teams/${teamId}/members/${memberId}`, { method: "DELETE" });
      mutate();
    } catch (err: any) { setActionError(err.message || "Couldn't remove the member."); }
  }

  // "Add to another team" — additive, keeps the current membership.
  async function handleMoveMember() {
    if (!moveModal || !moveTargetTeamId) return;
    setActionError(null);
    try {
      await apiFetch(`/teams/${moveTargetTeamId}/members`, { method: "POST", body: JSON.stringify({ userId: moveModal.memberId }) });
      setMoveModal(null);
      setMoveTargetTeamId("");
      mutate();
    } catch (err: any) { setActionError(err.message || "Couldn't add the member to that team."); }
  }

  const toggleExpand = (id: string) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleSelect = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Unique people across every unit (someone in two teams counts once).
  const memberIds = new Set<string>();
  let summed = 0;
  for (const u of allUnits) {
    for (const m of u.members ?? []) memberIds.add(m.id);
    summed += u._count?.members ?? u.members?.length ?? 0;
  }
  const totalMembers = memberIds.size || summed;
  const kpis = [
    { label: "Departments", value: allUnits.filter((u) => u.type === "DEPARTMENT").length, color: "#E9BD62", icon: Building2, note: "departments" },
    { label: "Teams", value: allUnits.filter((u) => u.type === "TEAM").length, color: "#238BFF", icon: Users, note: "teams" },
    { label: "Sub Teams", value: allUnits.filter((u) => u.type === "SUB_TEAM").length, color: "#00D7A0", icon: Users, note: "nested" },
    { label: "Total Members", value: totalMembers, color: "#9B7EDE", icon: Users, note: "unique people" },
  ];

  function renderUnit(team: any, depth = 0): React.ReactNode {
    const t = TYPES[team.type] ?? TYPES.TEAM;
    const Icon = t.icon;
    const isOpen = expanded.has(team.id);
    const isSel = selected.has(team.id);
    const members: any[] = team.members ?? [];
    const children: any[] = team.children ?? [];
    const memberCount = team._count?.members ?? members.length;
    const hasContent = members.length > 0 || children.length > 0;
    const meta = `${t.label} · ${plural(memberCount, "member")}${children.length ? ` · ${plural(children.length, "sub-unit")}` : ""}`;

    return (
      <div key={team.id} className="flex flex-col gap-1.5">
        <div
          className="flex items-center gap-3 px-3 py-2.5 rounded-[8px] border"
          style={{
            marginLeft: depth * 28,
            background: isSel ? "rgba(35,139,255,.08)" : isOpen ? "#0B1720" : "#0A1520",
            borderColor: isSel ? "rgba(35,139,255,.4)" : isOpen ? "#223543" : "#182C39",
          }}
        >
          <button
            type="button"
            onClick={() => toggleSelect(team.id)}
            aria-pressed={isSel}
            aria-label={`${isSel ? "Deselect" : "Select"} ${team.name}`}
            className="h-4 w-4 shrink-0 rounded-[4px] border-[1.5px] grid place-items-center text-white"
            style={{ borderColor: isSel ? "#238BFF" : "#33506A", background: isSel ? "#238BFF" : "transparent" }}
          >
            {isSel && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
          </button>
          <button
            type="button"
            onClick={() => hasContent && toggleExpand(team.id)}
            aria-expanded={hasContent ? isOpen : undefined}
            className={`flex-1 min-w-0 flex items-center gap-3 text-left text-ds-text ${hasContent ? "" : "cursor-default"}`}
          >
            <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-ds-t3 transition-transform ${isOpen ? "rotate-90" : ""} ${hasContent ? "" : "opacity-0"}`} />
            <span className="h-[34px] w-[34px] rounded-[9px] grid place-items-center shrink-0" style={{ background: rgba(t.color, 0.14), color: t.color }}>
              <Icon className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-[13px] font-semibold truncate">{toTitleCase(team.name)}</span>
              <span className="text-[10.5px] text-ds-t3">{meta}</span>
            </span>
          </button>
          <span className="hidden sm:flex items-center pl-1.5" aria-hidden="true">
            {members.slice(0, 3).map((m) => {
              const h = hash(m.name || "");
              return (
                <span key={m.id} className="h-6 w-6 -ml-1.5 rounded-full border-2 border-ds-card grid place-items-center text-[9.5px] font-bold" style={{ background: AV_BG[h % 5], color: AV_FG[h % 5] }}>
                  {(m.name || "?").charAt(0).toUpperCase()}
                </span>
              );
            })}
          </span>
          <span className="flex gap-1.5 shrink-0">
            <button type="button" onClick={() => setAssignModal({ teamId: team.id, teamName: team.name })} title="Add member" aria-label={`Add member to ${team.name}`} className={`${iconBtn} hover:border-ds-gold/55 hover:text-ds-gold`}>
              <UserPlus className="h-[13px] w-[13px]" strokeWidth={1.8} />
            </button>
            <button type="button" onClick={() => handleDelete(team.id)} title="Delete" aria-label={`Delete ${team.name}`} className={`${iconBtn} hover:border-[rgba(229,72,77,.6)] hover:text-[#FB7185]`}>
              <Trash2 className="h-[13px] w-[13px]" strokeWidth={1.8} />
            </button>
          </span>
        </div>

        {isOpen && (
          <>
            {members.map((m) => {
              const st = STATUS[m.status] ?? STATUS.INACTIVE;
              return (
                <div key={m.id} className="flex items-center gap-3 py-2 pr-3 pl-4 rounded-[6px] bg-ds-inset border border-ds-grid" style={{ marginLeft: depth * 28 + 42 }}>
                  <Avatar name={m.name} url={m.profileImageUrl} size={28} />
                  <span className="flex-1 min-w-0 leading-tight">
                    <span className="block text-[12px] font-semibold text-ds-text truncate">{toTitleCase(m.name)}</span>
                    <span className="block text-[10.5px] text-ds-t3 truncate">{m.email}</span>
                  </span>
                  {m.isPrimary && (
                    <span title="This is the member's primary team" className="h-5 px-[9px] rounded-[10px] border border-ds-gold/40 bg-ds-gold/[.14] text-ds-gold text-[10px] font-bold inline-flex items-center whitespace-nowrap">Primary</span>
                  )}
                  <span className="hidden sm:inline-flex items-center gap-1.5 h-5 px-[9px] rounded-[10px] border text-[10px] font-semibold whitespace-nowrap" style={{ color: st.color, background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.28) }}>
                    <i className="h-[5px] w-[5px] rounded-full" style={{ background: st.color }} />{st.label}
                  </span>
                  <span className="flex gap-1 shrink-0">
                    <button type="button" onClick={() => { setMoveModal({ memberId: m.id, memberName: m.name }); setMoveTargetTeamId(""); }} title="Add to another team" aria-label={`Add ${m.name} to another team`} className="h-6 w-6 rounded-[5px] border border-ds-line2 text-ds-t3 grid place-items-center transition-colors hover:border-[rgba(35,139,255,.55)] hover:text-[#6EB2FF]">
                      <ArrowRightLeft className="h-3 w-3" strokeWidth={1.8} />
                    </button>
                    <button type="button" onClick={() => handleRemoveMember(team.id, m.id)} title="Remove from this team" aria-label={`Remove ${m.name} from ${team.name}`} className="h-6 w-6 rounded-[5px] border border-ds-line2 text-ds-t3 grid place-items-center transition-colors hover:border-[rgba(229,72,77,.6)] hover:text-[#FB7185]">
                      <UserMinus className="h-3 w-3" strokeWidth={1.8} />
                    </button>
                  </span>
                </div>
              );
            })}
            {children.map((c) => renderUnit(c, depth + 1))}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div>
          <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] text-ds-text">Team Structure</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Organization hierarchy and team management</p>
        </div>
        <button
          type="button"
          onClick={() => { setCreateOpen((v) => !v); setCreateError(null); }}
          aria-expanded={createOpen}
          className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22]"
        >
          <Plus className="h-3.5 w-3.5" /> Create Team
        </button>
      </section>

      {/* Create form */}
      {createOpen && (
        <section className="mb-3.5 rounded-[8px] border border-ds-gold/35 bg-ds-card px-5 py-[18px]">
          <p className="text-[14px] font-semibold text-ds-text">Create New Team</p>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-3.5 items-end mt-3.5">
            <label className={fieldLabel}>
              Name
              <input
                value={form.name}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); setCreateError(null); }}
                required
                placeholder="e.g. Reels Squad"
                aria-invalid={!!createError}
                aria-describedby={createError ? "team-create-error" : undefined}
                className={`${fieldInput} w-[220px] ${createError ? "!border-ds-red" : ""}`}
              />
            </label>
            <div className={fieldLabel}>
              Type
              <span className="flex gap-0.5 p-0.5 h-9 items-center rounded-[8px] bg-ds-inset border border-ds-line2" role="group" aria-label="Unit type">
                {(["DEPARTMENT", "TEAM", "SUB_TEAM"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={form.type === k}
                    onClick={() => setForm({ ...form, type: k })}
                    className={`h-[30px] px-3 rounded-[6px] text-[11.5px] font-semibold normal-case tracking-normal whitespace-nowrap transition-colors ${form.type === k ? "bg-ds-blue text-white" : "text-ds-t2 hover:text-ds-text"}`}
                  >
                    {k === "SUB_TEAM" ? "Sub Team" : TYPES[k].label}
                  </button>
                ))}
              </span>
            </div>
            <label className={fieldLabel}>
              Parent (optional)
              <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} className={`${fieldInput} w-[220px] px-2.5`}>
                <option value="">None (Top-level)</option>
                {allUnits.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({TYPES[u.type]?.label ?? u.type})</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2 sm:ml-auto">
              <button type="button" onClick={() => setCreateOpen(false)} className={ghostBtn}>Cancel</button>
              <button type="submit" disabled={creating} className={`${goldBtn} px-[18px]`}>{creating ? "Creating…" : "Create"}</button>
            </div>
          </form>
          {createError && <p id="team-create-error" role="alert" className="mt-2.5 text-[11.5px] text-[#FB7185]">{createError}</p>}
        </section>
      )}

      {/* KPI cards */}
      <section className="grid gap-2.5 sm:gap-3.5 grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="flex flex-col min-[480px]:flex-row gap-2.5 min-[480px]:gap-3.5 min-[480px]:items-center p-3 sm:p-4 rounded-[8px] bg-ds-card border border-ds-line">
              <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(k.color, 0.13), color: k.color }}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-ds-t5">{k.label}</span>
                <span className="flex items-baseline gap-2 mt-1.5 whitespace-nowrap">
                  <span className="text-[26px] font-semibold tracking-[-.02em] leading-none text-ds-text">{isLoading ? "—" : k.value}</span>
                  <span className="text-[11px] text-ds-t3 truncate">{k.note}</span>
                </span>
              </span>
            </div>
          );
        })}
      </section>

      {/* Action error */}
      {actionError && (
        <section role="alert" className="flex items-center gap-3 mt-3.5 px-4 py-2.5 rounded-[8px] border border-[rgba(229,72,77,.4)] bg-[rgba(229,72,77,.08)]">
          <span className="flex-1 text-[12.5px] text-[#FB7185]">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss" className="text-ds-t3 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </section>
      )}

      {/* Bulk selection bar */}
      {selected.size > 0 && (
        <section className="flex items-center gap-3 flex-wrap mt-3.5 px-4 py-2.5 rounded-[8px] border border-[rgba(35,139,255,.35)] bg-[rgba(35,139,255,.08)]">
          <span className="flex-1 text-[12.5px] font-semibold text-[#6EB2FF]">{plural(selected.size, "team")} selected</span>
          <button type="button" onClick={() => setSelected(new Set())} className="h-7 px-3 rounded-[14px] border border-ds-line2 text-ds-t5 text-[11px] font-semibold hover:text-ds-text">Clear</button>
          <button type="button" onClick={handleBulkDelete} disabled={bulkDeleting} className="inline-flex items-center gap-1.5 h-7 px-3.5 rounded-[14px] bg-[#E5484D] text-white text-[11px] font-bold whitespace-nowrap disabled:opacity-60">
            <Trash2 className="h-3 w-3" strokeWidth={1.8} />
            {bulkDeleting ? "Deleting…" : `Delete selected (${selected.size})`}
          </button>
        </section>
      )}

      {/* Hierarchy */}
      <section className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line px-5 py-[18px]">
        <div className="flex justify-between items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-ds-text">Organization Hierarchy</p>
            <p className="text-[10.5px] text-ds-t3 mt-1">Click a unit to see its members and sub-teams</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setExpanded(new Set(allUnits.map((u) => u.id)))} className="h-[26px] px-3 rounded-[13px] border border-ds-line2 bg-ds-inset text-ds-t2 text-[11px] font-semibold whitespace-nowrap hover:text-ds-text">Expand all</button>
            <button type="button" onClick={() => setExpanded(new Set())} className="h-[26px] px-3 rounded-[13px] border border-ds-line2 bg-ds-inset text-ds-t2 text-[11px] font-semibold whitespace-nowrap hover:text-ds-text">Collapse all</button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5 mt-4">
          {isLoading ? (
            Array.from({ length: 5 }, (_, i) => <div key={i} className="h-[56px] rounded-[8px] bg-ds-hover motion-safe:animate-pulse" aria-hidden="true" />)
          ) : teams.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-ds-t3">No teams created yet. Click &ldquo;Create Team&rdquo; to get started.</p>
          ) : (
            teams.map((t: any) => renderUnit(t))
          )}
        </div>
      </section>

      {/* Add member */}
      {assignModal && (
        <Modal title={`Add Member to ${assignModal.teamName}`} sub="They stay in any other team they already belong to." onClose={() => setAssignModal(null)}>
          <select value={assignEmployeeId} onChange={(e) => setAssignEmployeeId(e.target.value)} aria-label="Employee" className={`${fieldInput} w-full h-[38px] mt-4 px-2.5`}>
            <option value="">Select an employee</option>
            {employees.map((emp: any) => (
              <option key={emp.id} value={emp.id}>{emp.name} — {emp.email}</option>
            ))}
          </select>
          <div className="flex justify-end gap-2 mt-[18px]">
            <button type="button" onClick={() => setAssignModal(null)} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={handleAssign} disabled={!assignEmployeeId} className={goldBtn}>Add to Team</button>
          </div>
        </Modal>
      )}

      {/* Add to another team */}
      {moveModal && (
        <Modal
          title="Add to Another Team"
          sub={<>Add <span className="font-semibold text-ds-text">{moveModal.memberName}</span> to an additional team. They stay in their current team(s).</>}
          onClose={() => setMoveModal(null)}
        >
          <select value={moveTargetTeamId} onChange={(e) => setMoveTargetTeamId(e.target.value)} aria-label="Team" className={`${fieldInput} w-full h-[38px] mt-4 px-2.5`}>
            <option value="">Select a team</option>
            {allUnits.map((u: any) => (
              <option key={u.id} value={u.id}>{u.name} ({TYPES[u.type]?.label ?? u.type})</option>
            ))}
          </select>
          <div className="flex justify-end gap-2 mt-[18px]">
            <button type="button" onClick={() => setMoveModal(null)} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={handleMoveMember} disabled={!moveTargetTeamId} className={goldBtn}>Add to Team</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
