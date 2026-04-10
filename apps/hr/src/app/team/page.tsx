"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Users, CheckCircle2, XCircle } from "lucide-react";

export default function TeamPage() {
  const { data, isLoading } = useSWR("/hr/team", (url) => apiFetch(url));
  const dashboard = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h2 className="text-4xl font-light text-[#1A1A1A] font-serif">My Team</h2>
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
        </div>
      </div>
    );
  }

  if (!dashboard?.teamName) {
    return (
      <div className="space-y-6">
        <h2 className="text-4xl font-light text-[#1A1A1A] font-serif">My Team</h2>
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <p className="text-[#B0B0B0]">You are not assigned to any team.</p>
        </div>
      </div>
    );
  }

  const members: any[] = dashboard.members ?? [];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h2 className="text-4xl font-light text-[#1A1A1A] font-serif">My Team</h2>
        <p className="text-[#7A7A7A] text-sm mt-1">{dashboard.teamName}</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Users className="h-5 w-5 text-[#1A1A1A]" />
            </div>
            <div>
              <p className="text-sm text-[#7A7A7A]">Team Name</p>
              <p className="text-lg font-semibold text-[#1A1A1A]">{dashboard.teamName}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Users className="h-5 w-5 text-[#1A1A1A]" />
            </div>
            <div>
              <p className="text-sm text-[#7A7A7A]">Members</p>
              <p className="text-2xl font-light text-[#1A1A1A] font-serif">{dashboard.memberCount}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${dashboard.submissionRate >= 70 ? "bg-green-50" : "bg-amber-50"}`}>
              <CheckCircle2 className={`h-5 w-5 ${dashboard.submissionRate >= 70 ? "text-green-600" : "text-amber-600"}`} />
            </div>
            <div>
              <p className="text-sm text-[#7A7A7A]">Today&apos;s Submission Rate</p>
              <p className="text-2xl font-light text-[#1A1A1A] font-serif">{dashboard.submissionRate}%</p>
            </div>
          </div>
        </div>
      </div>

      {/* Members Table */}
      <div className="bg-white rounded-2xl border border-[#E8E0D0] overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <div className="px-6 py-4 border-b border-[#E8E0D0]">
          <h3 className="font-semibold text-[#1A1A1A]">Team Members</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#E8E0D0] bg-[#FEFCF7]">
                <th className="text-left py-3 px-6 font-medium text-[#7A7A7A]">Name</th>
                <th className="text-left py-3 px-4 font-medium text-[#7A7A7A]">Email</th>
                <th className="text-center py-3 px-4 font-medium text-[#7A7A7A]">Today</th>
                <th className="text-center py-3 px-4 font-medium text-[#7A7A7A]">Weekly Reports</th>
                <th className="text-center py-3 px-4 font-medium text-[#7A7A7A]">Total Links</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[#B0B0B0]">
                    No team members found.
                  </td>
                </tr>
              ) : (
                members.map((member: any) => (
                  <tr key={member.id} className="border-b border-[#E8E0D0]/50 last:border-0 hover:bg-[#FEFCF7] transition-colors">
                    <td className="py-3.5 px-6">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-full bg-[#F5D547] flex items-center justify-center text-xs font-bold text-[#1A1A1A]">
                          {member.name?.charAt(0)?.toUpperCase() || "?"}
                        </div>
                        <span className="font-medium text-[#1A1A1A]">{member.name}</span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-[#7A7A7A]">{member.email}</td>
                    <td className="py-3.5 px-4 text-center">
                      {member.submittedToday ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-400 mx-auto" />
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <span className="font-medium text-[#1A1A1A]">{member.weeklyReports}</span>
                      <span className="text-[#B0B0B0]">/7</span>
                    </td>
                    <td className="py-3.5 px-4 text-center font-medium text-[#1A1A1A]">{member.totalLinks}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
