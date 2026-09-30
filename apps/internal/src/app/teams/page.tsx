"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch, API_BASE } from "@/lib/api";
import { useEmployees } from "@/lib/hooks/use-employees";
import { formatStatus, pluralize, toTitleCase } from "@dashmani/shared";
import { Users, Building2, Plus, ChevronDown, ChevronRight, Trash2, UserPlus, CheckSquare, Square, UserMinus, ArrowRightLeft } from "lucide-react";
import { Input } from "@dashmani/ui";

// Presentation-only helpers (Teams.dc.html): per-type icon/tint and deterministic avatar colours.
const TYPE_STYLE: Record<string, { Icon: any; bg: string; fg: string; label: string }> = {
  DEPARTMENT: { Icon: Building2, bg: "bg-terra/15", fg: "text-terra", label: "Department" },
  TEAM: { Icon: Users, bg: "bg-action/15", fg: "text-action", label: "Team" },
  SUB_TEAM: { Icon: Users, bg: "bg-sage/15", fg: "text-sage", label: "Sub team" },
};
const AVATAR_TONES = [
  "bg-action/15 text-action", "bg-sage/15 text-sage", "bg-gold/15 text-gold",
  "bg-danger/15 text-danger", "bg-terra/15 text-terra",
];
function avatarTone(name: string) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
}
const STATUS_TONE: Record<string, string> = {
  ACTIVE: "bg-sage/15 text-sage",
  ONBOARDING: "bg-gold/15 text-gold",
  INACTIVE: "bg-muted text-ink-4",
};

export default function TeamsPage() {
  const { data: teamsData, mutate } = useSWR("/teams", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  // limit:500 — the "Add Member" dropdown must list ALL employees. Without it the
  // API caps at 50 (sorted by name), silently hiding everyone past ~rank 50.
  const { data: employeesData } = useEmployees({ limit: 500 });

  const teams = (teamsData as any)?.data ?? [];
  const employees = (employeesData as any)?.data ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "TEAM" as string, parentId: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [assignModal, setAssignModal] = useState<{ teamId: string; teamName: string } | null>(null);
  const [assignEmployeeId, setAssignEmployeeId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // member move modal: { memberId, memberName, currentTeamId }
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
    } catch (e: any) {
      setCreateError(e.message || "Failed to create team");
    } finally { setCreating(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this team? Members will be unassigned.")) return;
    try {
      await apiFetch(`/teams/${id}`, { method: "DELETE" });
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (!confirm(`Delete ${ids.length} team(s)? All members will be unassigned.`)) return;
    setBulkDeleting(true);
    try {
      await apiFetch("/teams/bulk", {
        method: "DELETE",
        body: JSON.stringify({ ids }),
      });
      setSelected(new Set());
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setBulkDeleting(false); }
  }

  async function handleAssign() {
    if (!assignModal || !assignEmployeeId) return;
    try {
      // Additive: adds the person to this team WITHOUT removing them from any
      // other team they already belong to (POST creates a membership row).
      await apiFetch(`/teams/${assignModal.teamId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: assignEmployeeId }),
      });
      setAssignModal(null);
      setAssignEmployeeId("");
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  // Removes the member from THIS team only — leaves their other teams intact.
  async function handleRemoveMember(teamId: string, memberId: string) {
    try {
      await apiFetch(`/teams/${teamId}/members/${memberId}`, { method: "DELETE" });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  // "Add to another team" — additive, keeps the current membership.
  async function handleMoveMember() {
    if (!moveModal || !moveTargetTeamId) return;
    try {
      await apiFetch(`/teams/${moveTargetTeamId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: moveModal.memberId }),
      });
      setMoveModal(null);
      setMoveTargetTeamId("");
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function toggleSelect(id: string) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function renderTeam(team: any, depth = 0) {
    const isExpanded = expanded.has(team.id);
    const isSelected = selected.has(team.id);
    const members = team.members ?? [];
    const children = team.children ?? [];
    const hasContent = members.length > 0 || children.length > 0;
    const ts = TYPE_STYLE[team.type] ?? TYPE_STYLE.TEAM;

    return (
      <div key={team.id} style={{ marginLeft: depth * 24 }}>
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] border mb-1.5 transition-all ${
          isSelected ? "bg-action/10 border-action/35" : "bg-muted border-border"
        }`}>
          {/* Checkbox */}
          <button
            onClick={() => toggleSelect(team.id)}
            className="shrink-0 text-ink-4 hover:text-action transition-colors"
            title={isSelected ? "Deselect" : "Select"}
          >
            {isSelected ? <CheckSquare className="h-4 w-4 text-action" /> : <Square className="h-4 w-4" />}
          </button>

          <button onClick={() => toggleExpand(team.id)} className="shrink-0">
            {hasContent ? (isExpanded ? <ChevronDown className="h-4 w-4 text-ink-4" /> : <ChevronRight className="h-4 w-4 text-ink-4" />) : <div className="w-4" />}
          </button>
          <div className={`h-8 w-8 rounded-[10px] ${ts.bg} flex items-center justify-center shrink-0`}>
            <ts.Icon className={`h-4 w-4 ${ts.fg}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink text-[13px] truncate">{toTitleCase(team.name)}</p>
            <p className="text-[11px] text-ink-4 mt-0.5">{ts.label} &middot; {pluralize(team._count?.members ?? members.length, "member")}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setAssignModal({ teamId: team.id, teamName: team.name })}
              className="h-7 w-7 flex items-center justify-center rounded-lg border border-border text-ink-4 hover:border-ink/30 hover:text-ink transition-colors"
              title="Add member"
            >
              <UserPlus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => handleDelete(team.id)}
              className="h-7 w-7 flex items-center justify-center rounded-lg border border-border text-ink-4 hover:border-danger/60 hover:text-danger transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="ml-4 mb-2">
            {members.length > 0 && (
              <div className="space-y-1 mb-2">
                {members.map((m: any) => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-2 pl-4 rounded-lg bg-muted/60 group">
                    {m.profileImageUrl ? (
                      <img src={m.profileImageUrl.startsWith("http") ? m.profileImageUrl : `${API_BASE}${m.profileImageUrl}`} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className={`h-[26px] w-[26px] rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${avatarTone(m.name)}`}>
                        {m.name?.[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-ink truncate">{toTitleCase(m.name)}</p>
                      <p className="text-[11px] text-ink-4 truncate">{m.email}</p>
                    </div>
                    {m.isPrimary && (
                      <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-gold/15 text-gold whitespace-nowrap" title="This is the member's primary team">
                        Primary
                      </span>
                    )}
                    <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-semibold whitespace-nowrap ${STATUS_TONE[m.status] ?? "bg-muted text-ink-4"}`}>
                      {formatStatus(m.status)}
                    </span>
                    {/* Member actions — visible on hover */}
                    <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={() => { setMoveModal({ memberId: m.id, memberName: m.name }); setMoveTargetTeamId(""); }}
                        className="h-6 w-6 flex items-center justify-center rounded-md border border-border text-ink-4 hover:border-action/50 hover:text-action transition-colors"
                        title="Add to another team"
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleRemoveMember(team.id, m.id)}
                        className="h-6 w-6 flex items-center justify-center rounded-md border border-border text-ink-4 hover:border-danger/60 hover:text-danger transition-colors"
                        title="Remove from this team"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {children.map((child: any) => renderTeam(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[30px] font-semibold text-ink leading-tight">Team Structure</h1>
          <p className="text-[13px] text-ink-4 mt-1">Organization hierarchy and team management</p>
        </div>
        <button
          onClick={() => { setCreateOpen(!createOpen); setCreateError(null); }}
          className="inline-flex items-center gap-1.5 h-[38px] px-[18px] rounded-xl bg-gradient-to-b from-action-deep to-action text-[#06121B] text-[13px] font-bold shadow-[0_1px_0_rgba(255,255,255,.4)_inset,0_6px_16px_rgb(var(--t-action)/0.28)] hover:-translate-y-0.5 transition-all"
        >
          <Plus className="h-4 w-4" /> Create Team
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-action/10 border border-action/30">
          <p className="text-[13px] font-bold text-action flex-1">
            {selected.size} team{selected.size !== 1 ? "s" : ""} selected
          </p>
          <button
            onClick={() => setSelected(new Set())}
            className="h-[30px] px-3.5 rounded-full text-xs font-semibold text-ink-2 hover:text-ink border border-border transition-colors"
          >
            Clear
          </button>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="flex items-center gap-1.5 h-[30px] px-4 rounded-full bg-danger text-white text-xs font-bold hover:bg-danger/90 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {bulkDeleting ? "Deleting…" : `Delete selected (${selected.size})`}
          </button>
        </div>
      )}

      {/* Create Form */}
      {createOpen && (
        <div className="v3-card p-5">
          <h3 className="font-display text-base font-semibold text-ink mb-3.5">Create New Team</h3>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-ink-4">Name</label>
              <Input
                value={form.name}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); setCreateError(null); }}
                required
                className={`w-52 h-[38px] border rounded-[10px] bg-muted ${createError ? "border-danger focus:ring-danger" : "border-border"}`}
              />
              {createError && (
                <p className="text-xs text-danger mt-0.5">{createError}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-ink-4">Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="h-[38px] rounded-[10px] border border-border bg-muted text-ink px-3 text-[13px] w-40">
                <option value="DEPARTMENT">Department</option>
                <option value="TEAM">Team</option>
                <option value="SUB_TEAM">Sub Team</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-ink-4">Parent (optional)</label>
              <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} className="h-[38px] rounded-[10px] border border-border bg-muted text-ink px-3 text-[13px] w-52">
                <option value="">None (Top-level)</option>
                {allUnits.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={creating} className="h-[38px] px-5 rounded-full bg-ink text-bg text-[13px] font-bold hover:opacity-90 transition-all disabled:opacity-50">
              {creating ? "Creating..." : "Create"}
            </button>
          </form>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="v3-card-sm !rounded-[14px] p-[18px]">
          <p className="text-xs text-ink-4 font-semibold">Departments</p>
          <p className="text-[30px] font-light font-num mt-1.5 text-terra">{allUnits.filter((u: any) => u.type === "DEPARTMENT").length}</p>
        </div>
        <div className="v3-card-sm !rounded-[14px] p-[18px]">
          <p className="text-xs text-ink-4 font-semibold">Teams</p>
          <p className="text-[30px] font-light font-num mt-1.5 text-action">{allUnits.filter((u: any) => u.type === "TEAM").length}</p>
        </div>
        <div className="v3-card-sm !rounded-[14px] p-[18px]">
          <p className="text-xs text-ink-4 font-semibold">Sub Teams</p>
          <p className="text-[30px] font-light font-num mt-1.5 text-sage">{allUnits.filter((u: any) => u.type === "SUB_TEAM").length}</p>
        </div>
        <div className="v3-card-sm !rounded-[14px] p-[18px]">
          <p className="text-xs text-ink-4 font-semibold">Total Members</p>
          <p className="text-[30px] font-light font-num mt-1.5 text-ink">{allUnits.reduce((s: number, u: any) => s + (u._count?.members ?? u.members?.length ?? 0), 0)}</p>
        </div>
      </div>

      {/* Hierarchy */}
      <div className="v3-card p-5">
        <h3 className="font-display text-base font-semibold text-ink mb-3.5">Organization Hierarchy</h3>
        {teams.length === 0 ? (
          <p className="text-sm text-ink-4">No teams created yet. Click "Create Team" to get started.</p>
        ) : (
          <div className="space-y-1">
            {teams.map((team: any) => renderTeam(team))}
          </div>
        )}
      </div>

      {/* Move Member Modal */}
      {moveModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setMoveModal(null)}>
          <div className="v3-card shadow-pop p-[22px] w-full max-w-[380px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-base font-semibold text-ink mb-1">Add to Another Team</h3>
            <p className="text-xs text-ink-4 mb-3.5">Add <span className="font-semibold text-ink">{moveModal.memberName}</span> to an additional team. They stay in their current team(s).</p>
            <select
              value={moveTargetTeamId}
              onChange={(e) => setMoveTargetTeamId(e.target.value)}
              className="w-full h-[38px] rounded-[10px] border border-border bg-muted text-ink px-3 text-[13px] mb-4"
            >
              <option value="">Select a team</option>
              {allUnits.map((u: any) => (
                <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMoveModal(null)} className="h-9 px-4 rounded-full border border-border text-[13px] font-semibold text-ink-4 hover:text-ink transition-colors">Cancel</button>
              <button
                onClick={handleMoveMember}
                disabled={!moveTargetTeamId}
                className="h-9 px-[18px] rounded-full bg-ink text-bg text-[13px] font-bold hover:opacity-90 disabled:opacity-50"
              >
                Add to Team
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Member Modal */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setAssignModal(null)}>
          <div className="v3-card shadow-pop p-[22px] w-full max-w-[380px]" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display text-base font-semibold text-ink mb-3.5">Add Member to {assignModal.teamName}</h3>
            <select
              value={assignEmployeeId}
              onChange={(e) => setAssignEmployeeId(e.target.value)}
              className="w-full h-[38px] rounded-[10px] border border-border bg-muted text-ink px-3 text-[13px] mb-4"
            >
              <option value="">Select an employee</option>
              {employees.map((emp: any) => (
                <option key={emp.id} value={emp.id}>{emp.name} — {emp.email}</option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setAssignModal(null)} className="h-9 px-4 rounded-full border border-border text-[13px] font-semibold text-ink-4 hover:text-ink transition-colors">Cancel</button>
              <button
                onClick={handleAssign}
                disabled={!assignEmployeeId}
                className="h-9 px-[18px] rounded-full bg-ink text-bg text-[13px] font-bold hover:opacity-90 disabled:opacity-50"
              >
                Add to Team
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
