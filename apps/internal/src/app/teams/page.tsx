"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch, API_BASE } from "@/lib/api";
import { useEmployees } from "@/lib/hooks/use-employees";
import { formatStatus } from "@dashmani/shared";
import { Users, Plus, ChevronDown, ChevronRight, Trash2, UserPlus, CheckSquare, Square, UserMinus, ArrowRightLeft } from "lucide-react";
import { Input } from "@dashmani/ui";

export default function TeamsPage() {
  const { data: teamsData, mutate } = useSWR("/teams", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  const { data: employeesData } = useEmployees();

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
      await apiFetch(`/employees/${assignEmployeeId}`, {
        method: "PUT",
        body: JSON.stringify({ orgUnitId: assignModal.teamId }),
      });
      setAssignModal(null);
      setAssignEmployeeId("");
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleRemoveMember(memberId: string) {
    try {
      await apiFetch(`/employees/${memberId}`, {
        method: "PUT",
        body: JSON.stringify({ orgUnitId: null }),
      });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleMoveMember() {
    if (!moveModal) return;
    try {
      await apiFetch(`/employees/${moveModal.memberId}`, {
        method: "PUT",
        body: JSON.stringify({ orgUnitId: moveTargetTeamId || null }),
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

    return (
      <div key={team.id} style={{ marginLeft: depth * 24 }}>
        <div className={`flex items-center gap-3 p-3 rounded-xl border mb-2 transition-all hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] ${
          isSelected ? "bg-indigo-soft border-indigo/30" : "bg-white border-[#E8E0D0]"
        }`}>
          {/* Checkbox */}
          <button
            onClick={() => toggleSelect(team.id)}
            className="shrink-0 text-ink-4 hover:text-indigo transition-colors"
            title={isSelected ? "Deselect" : "Select"}
          >
            {isSelected ? <CheckSquare className="h-4 w-4 text-indigo" /> : <Square className="h-4 w-4" />}
          </button>

          <button onClick={() => toggleExpand(team.id)} className="shrink-0">
            {hasContent ? (isExpanded ? <ChevronDown className="h-4 w-4 text-[#7A7A7A]" /> : <ChevronRight className="h-4 w-4 text-[#7A7A7A]" />) : <div className="w-4" />}
          </button>
          <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center shrink-0">
            <Users className="h-4 w-4 text-[#1A1A1A]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[#1A1A1A] text-sm">{team.name}</p>
            <p className="text-xs text-[#7A7A7A]">{team.type} &middot; {team._count?.members ?? members.length} members</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setAssignModal({ teamId: team.id, teamName: team.name })}
              className="p-1.5 rounded-lg hover:bg-[#FFF8E1] text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors"
              title="Add member"
            >
              <UserPlus className="h-4 w-4" />
            </button>
            <button
              onClick={() => handleDelete(team.id)}
              className="p-1.5 rounded-lg hover:bg-red-50 text-[#7A7A7A] hover:text-red-600 transition-colors"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div className="ml-4 mb-2">
            {members.length > 0 && (
              <div className="space-y-1 mb-2">
                {members.map((m: any) => (
                  <div key={m.id} className="flex items-center gap-3 p-2 pl-4 rounded-lg bg-[rgba(255,248,225,0.5)] group">
                    {m.profileImageUrl ? (
                      <img src={m.profileImageUrl.startsWith("http") ? m.profileImageUrl : `${API_BASE}${m.profileImageUrl}`} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0" style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}>
                        {m.name?.[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1A1A1A]">{m.name}</p>
                      <p className="text-xs text-[#7A7A7A]">{m.email}</p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${m.status === "ACTIVE" ? "bg-green-50 text-green-700" : "bg-[#FFF3C4] text-[#1A1A1A]"}`}>
                      {formatStatus(m.status)}
                    </span>
                    {/* Member actions — visible on hover */}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => { setMoveModal({ memberId: m.id, memberName: m.name }); setMoveTargetTeamId(""); }}
                        className="p-1 rounded-md hover:bg-indigo-soft text-ink-4 hover:text-indigo transition-colors"
                        title="Move to another team"
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleRemoveMember(m.id)}
                        className="p-1 rounded-md hover:bg-red-50 text-ink-4 hover:text-red-600 transition-colors"
                        title="Remove from team"
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Team Structure</h1>
          <p className="text-[#7A7A7A] mt-1">Organization hierarchy and team management</p>
        </div>
        <button
          onClick={() => { setCreateOpen(!createOpen); setCreateError(null); }}
          className="inline-flex items-center gap-2 bg-[#F5D547] text-[#1A1A1A] rounded-full px-5 py-2.5 text-sm font-medium shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 transition-all"
        >
          <Plus className="h-4 w-4" /> Create Team
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="v3-card p-3 flex items-center gap-3 bg-indigo-soft border-indigo/20">
          <p className="text-sm font-semibold text-indigo flex-1">
            {selected.size} team{selected.size !== 1 ? "s" : ""} selected
          </p>
          <button
            onClick={() => setSelected(new Set())}
            className="px-3 py-1.5 rounded-full text-xs font-medium text-ink-4 hover:text-ink border-2 border-ink/15 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-danger text-white text-xs font-bold hover:bg-danger/90 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {bulkDeleting ? "Deleting…" : `Delete selected (${selected.size})`}
          </button>
        </div>
      )}

      {/* Create Form */}
      {createOpen && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-6">
          <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-4">Create New Team</h3>
          <form onSubmit={handleCreate} className="flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Name</label>
              <Input
                value={form.name}
                onChange={(e) => { setForm({ ...form, name: e.target.value }); setCreateError(null); }}
                required
                className={`w-52 border rounded-lg ${createError ? "border-red-400 focus:ring-red-400" : "border-[#E8E0D0]"}`}
              />
              {createError && (
                <p className="text-xs text-red-600 mt-0.5">{createError}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Type</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="h-9 rounded-lg border border-[#E8E0D0] bg-white px-3 py-1 text-sm w-40">
                <option value="DEPARTMENT">Department</option>
                <option value="TEAM">Team</option>
                <option value="SUB_TEAM">Sub Team</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Parent (optional)</label>
              <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} className="h-9 rounded-lg border border-[#E8E0D0] bg-white px-3 py-1 text-sm w-52">
                <option value="">None (Top-level)</option>
                {allUnits.map((u: any) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={creating} className="bg-[#1A1A1A] text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50">
              {creating ? "Creating..." : "Create"}
            </button>
          </form>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <p className="text-sm text-[#7A7A7A]">Departments</p>
          <p className="text-[32px] font-light font-serif text-[#1A1A1A]">{allUnits.filter((u: any) => u.type === "DEPARTMENT").length}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <p className="text-sm text-[#7A7A7A]">Teams</p>
          <p className="text-[32px] font-light font-serif text-[#1A1A1A]">{allUnits.filter((u: any) => u.type === "TEAM").length}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <p className="text-sm text-[#7A7A7A]">Sub Teams</p>
          <p className="text-[32px] font-light font-serif text-[#1A1A1A]">{allUnits.filter((u: any) => u.type === "SUB_TEAM").length}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <p className="text-sm text-[#7A7A7A]">Total Members</p>
          <p className="text-[32px] font-light font-serif text-[#1A1A1A]">{allUnits.reduce((s: number, u: any) => s + (u._count?.members ?? u.members?.length ?? 0), 0)}</p>
        </div>
      </div>

      {/* Hierarchy */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-6">
        <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-4">Organization Hierarchy</h3>
        {teams.length === 0 ? (
          <p className="text-sm text-[#7A7A7A]">No teams created yet. Click "Create Team" to get started.</p>
        ) : (
          <div className="space-y-1">
            {teams.map((team: any) => renderTeam(team))}
          </div>
        )}
      </div>

      {/* Move Member Modal */}
      {moveModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setMoveModal(null)}>
          <div className="bg-white rounded-2xl p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-1">Move Member</h3>
            <p className="text-sm text-[#7A7A7A] mb-4">Moving <span className="font-semibold text-[#1A1A1A]">{moveModal.memberName}</span> to a new team</p>
            <select
              value={moveTargetTeamId}
              onChange={(e) => setMoveTargetTeamId(e.target.value)}
              className="w-full h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 text-sm mb-4"
            >
              <option value="">— Remove from all teams —</option>
              {allUnits.map((u: any) => (
                <option key={u.id} value={u.id}>{u.name} ({u.type})</option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMoveModal(null)} className="px-4 py-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A]">Cancel</button>
              <button
                onClick={handleMoveMember}
                className="bg-[#1A1A1A] text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#2B2B2B]"
              >
                {moveTargetTeamId ? "Move" : "Remove from team"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Member Modal */}
      {assignModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setAssignModal(null)}>
          <div className="bg-white rounded-2xl p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-4">Add Member to {assignModal.teamName}</h3>
            <select
              value={assignEmployeeId}
              onChange={(e) => setAssignEmployeeId(e.target.value)}
              className="w-full h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 text-sm mb-4"
            >
              <option value="">Select an employee</option>
              {employees.map((emp: any) => (
                <option key={emp.id} value={emp.id}>{emp.name} — {emp.email}</option>
              ))}
            </select>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setAssignModal(null)} className="px-4 py-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A]">Cancel</button>
              <button
                onClick={handleAssign}
                disabled={!assignEmployeeId}
                className="bg-[#1A1A1A] text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50"
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
