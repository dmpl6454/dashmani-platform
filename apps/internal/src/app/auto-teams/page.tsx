"use client";
import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { Users, Plus, Check, ExternalLink, UserPlus } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

export default function AutoTeamsPage() {
  const { data, isLoading, mutate } = useSWR("/admin/auto-teams", (url: string) => apiFetch<any>(url));
  const sharedAccounts = data?.data || [];
  const [creating, setCreating] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  async function createTeam(account: any) {
    if (!teamName.trim()) return;
    setCreating(account.accountId);
    try {
      await apiFetch("/admin/auto-teams/create", {
        method: "POST",
        body: JSON.stringify({
          name: teamName,
          accountId: account.accountId,
          memberIds: account.members.map((m: any) => m.id),
        }),
      });
      setSuccessMsg(`Team "${teamName}" created with ${account.members.length} members!`);
      setTeamName("");
      setCreating(null);
      mutate();
      setTimeout(() => setSuccessMsg(""), 4000);
    } catch (e: any) {
      alert(e.message);
      setCreating(null);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Auto-Detected Teams</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Employees working on the same social accounts are automatically grouped. Create teams from these groups.</p>
        </div>
        <div className="flex items-center gap-2 bg-[#FFF3C4] px-4 py-2 rounded-full">
          <Users className="h-4 w-4 text-[#B8960C]" />
          <span className="text-sm font-semibold text-[#1A1A1A]">{sharedAccounts.length} Shared Accounts</span>
        </div>
      </div>

      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
          <Check className="h-4 w-4" /> {successMsg}
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
        </div>
      ) : sharedAccounts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center">
          <Users className="h-12 w-12 mx-auto mb-3 text-[#B0B0B0]" />
          <p className="text-[#7A7A7A] font-medium">No shared accounts found</p>
          <p className="text-sm text-[#B0B0B0] mt-1">Teams will appear here when multiple employees are assigned to the same account</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {sharedAccounts.map((account: any) => (
            <div key={account.accountId} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] overflow-hidden">
              {/* Account Header */}
              <div className="bg-[#FEFCF7] border-b border-[#F0EAD8] p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center text-lg font-bold text-[#1A1A1A]">
                    {account.platform?.[0] || "?"}
                  </div>
                  <div>
                    <p className="font-semibold text-[#1A1A1A]">{account.displayName || account.handle}</p>
                    <p className="text-xs text-[#7A7A7A]">{account.platform} · @{account.handle} {account.clientName ? `· ${account.clientName}` : ""}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-xs text-[#7A7A7A]">Followers</p>
                  <p className="text-sm font-semibold text-[#1A1A1A]">{(account.followerCount || 0).toLocaleString()}</p>
                </div>
              </div>

              {/* Members */}
              <div className="p-4 space-y-2">
                <p className="text-xs font-medium text-[#7A7A7A] uppercase tracking-wide mb-2">{account.members.length} Team Members</p>
                {account.members.map((member: any) => (
                  <div key={member.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-[#FEFCF7] transition-colors">
                    {member.profileImageUrl ? (
                      <img src={member.profileImageUrl.startsWith("http") ? member.profileImageUrl : `${API_BASE}${member.profileImageUrl}`} alt="" className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-[#FFF3C4] flex items-center justify-center text-sm font-bold text-[#1A1A1A]">
                        {member.name?.[0]?.toUpperCase() || "?"}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#1A1A1A] truncate">{member.name}</p>
                      <p className="text-xs text-[#7A7A7A]">{member.email}</p>
                    </div>
                    {member.currentTeam && (
                      <span className="text-xs bg-[#FFF3C4] text-[#B8960C] px-2.5 py-1 rounded-full font-medium">{member.currentTeam}</span>
                    )}
                  </div>
                ))}
              </div>

              {/* Create Team Action */}
              <div className="border-t border-[#F0EAD8] p-4 bg-[#FEFCF7]">
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder={`Team name (e.g., "${account.handle} Team")`}
                    value={creating === account.accountId ? teamName : ""}
                    onFocus={() => { setCreating(account.accountId); if (!teamName) setTeamName(`${account.displayName || account.handle} Team`); }}
                    onChange={(e) => { setCreating(account.accountId); setTeamName(e.target.value); }}
                    className={inputClass}
                  />
                  <button
                    onClick={() => createTeam(account)}
                    disabled={creating === account.accountId && !teamName.trim()}
                    className="flex items-center gap-2 bg-[#1A1A1A] text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all whitespace-nowrap"
                  >
                    <UserPlus className="h-4 w-4" /> Create Team
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
