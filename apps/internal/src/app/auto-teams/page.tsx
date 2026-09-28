"use client";
import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { Users, Plus, Check, ExternalLink, UserPlus } from "lucide-react";

const inputClass = "w-full border border-border bg-surface rounded-lg px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-action focus:border-action transition-colors";

export default function AutoTeamsPage() {
  const { data, isLoading, mutate } = useSWR("/admin/auto-teams", (url: string) => apiFetch<any>(url));
  const sharedAccounts = data?.data || [];
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState("");

  async function createTeam(account: any) {
    const name = (teamNames[account.accountId] || "").trim();
    if (!name) return;
    setSubmitting(account.accountId);
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
      alert(e.message);
      setSubmitting(null);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-light text-ink">Auto-Detected Teams</h1>
          <p className="text-sm text-ink-3 mt-1">Employees working on the same social accounts are automatically grouped. Create teams from these groups.</p>
        </div>
        <div className="flex items-center gap-2 bg-action-soft px-4 py-2 rounded-full">
          <Users className="h-4 w-4 text-gold" />
          <span className="text-sm font-semibold text-ink">{sharedAccounts.length} Shared Accounts</span>
        </div>
      </div>

      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
          <Check className="h-4 w-4" /> {successMsg}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" />
        </div>
      ) : sharedAccounts.length === 0 ? (
        <div className="bg-surface rounded-2xl border border-border p-12 text-center">
          <Users className="h-12 w-12 mx-auto mb-3 text-ink-4" />
          <p className="text-ink-3 font-medium">No shared accounts found</p>
          <p className="text-sm text-ink-4 mt-1">Teams will appear here when multiple employees are assigned to the same account</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {sharedAccounts.map((account: any) => (
            <div key={account.accountId} className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border overflow-hidden">
              {/* Account Header */}
              <div className="bg-surface border-b border-border p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-action-soft flex items-center justify-center text-lg font-bold text-ink">
                    {account.platform?.[0] || "?"}
                  </div>
                  <div>
                    <p className="font-semibold text-ink">{account.displayName || account.handle}</p>
                    <p className="text-xs text-ink-3">{account.platform} · @{account.handle} {account.clientName ? `· ${account.clientName}` : ""}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-ink-3">Followers</p>
                  <p className="text-sm font-semibold text-ink">{(account.followerCount || 0).toLocaleString()}</p>
                </div>
              </div>

              {/* Members */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-medium text-ink-3 uppercase tracking-wide mb-2">{account.members.length} Team Members</p>
                {account.members.map((member: any) => (
                  <div key={member.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface transition-colors">
                    {member.profileImageUrl ? (
                      <img src={member.profileImageUrl.startsWith("http") ? member.profileImageUrl : `${API_BASE}${member.profileImageUrl}`} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-action-soft flex items-center justify-center text-sm font-bold text-ink">
                        {member.name?.[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{member.name}</p>
                      <p className="text-xs text-ink-3 truncate">{member.email}</p>
                    </div>
                    {member.currentTeam && (
                      <span className="text-xs bg-action-soft text-gold px-2.5 py-1 rounded-full font-medium">{member.currentTeam}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Create Team Action */}
              <div className="border-t border-border p-4 bg-surface">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={`Team name (e.g., "${account.handle} Team")`}
                    value={teamNames[account.accountId] ?? ""}
                    onFocus={() => { if (!teamNames[account.accountId]) setTeamNames((prev) => ({ ...prev, [account.accountId]: `${account.displayName || account.handle} Team` })); }}
                    onChange={(e) => setTeamNames((prev) => ({ ...prev, [account.accountId]: e.target.value }))}
                    className={inputClass}
                  />
                  <button
                    onClick={() => createTeam(account)}
                    disabled={submitting === account.accountId || !teamNames[account.accountId]?.trim()}
                    className="flex items-center gap-2 bg-action text-[#06121B] px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#243645] disabled:opacity-50 transition-all whitespace-nowrap"
                  >
                    <UserPlus className="h-4 w-4" /> {submitting === account.accountId ? "Creating..." : "Create Team"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
