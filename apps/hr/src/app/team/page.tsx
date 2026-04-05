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
        <h2 className="text-2xl font-bold">My Team</h2>
        <p className="text-sm text-gray-500">Loading team data...</p>
      </div>
    );
  }

  if (!dashboard?.teamName) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">My Team</h2>
        <p className="text-sm text-gray-500">You are not assigned to any team.</p>
      </div>
    );
  }

  const members: any[] = dashboard.members ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">My Team</h2>
        <p className="text-gray-500 text-sm mt-1">{dashboard.teamName}</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-blue-100 p-2">
              <Users className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Team Name</p>
              <p className="text-lg font-semibold text-gray-900">{dashboard.teamName}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-indigo-100 p-2">
              <Users className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Members</p>
              <p className="text-lg font-semibold text-gray-900">{dashboard.memberCount}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-center gap-3">
            <div className={`rounded-full p-2 ${dashboard.submissionRate >= 70 ? "bg-green-100" : "bg-orange-100"}`}>
              <CheckCircle2 className={`h-5 w-5 ${dashboard.submissionRate >= 70 ? "text-green-600" : "text-orange-600"}`} />
            </div>
            <div>
              <p className="text-sm text-gray-500">Today's Submission Rate</p>
              <p className="text-lg font-semibold text-gray-900">{dashboard.submissionRate}%</p>
            </div>
          </div>
        </div>
      </div>

      {/* Members Table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Team Members</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left py-3 px-5 font-medium text-gray-500">Name</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500">Email</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Today</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Weekly Reports</th>
                <th className="text-center py-3 px-4 font-medium text-gray-500">Total Links</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-gray-400">
                    No team members found.
                  </td>
                </tr>
              ) : (
                members.map((member: any) => (
                  <tr key={member.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-5 font-medium text-gray-900">{member.name}</td>
                    <td className="py-3 px-4 text-gray-500">{member.email}</td>
                    <td className="py-3 px-4 text-center">
                      {member.submittedToday ? (
                        <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-400 mx-auto" />
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className="font-medium">{member.weeklyReports}</span>
                      <span className="text-gray-400">/7</span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium">{member.totalLinks}</td>
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
