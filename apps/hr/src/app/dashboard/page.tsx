"use client";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useHrAuth } from "@/lib/auth";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport } from "@/lib/hooks/use-reports";

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500",
  instagram: "bg-pink-500",
  youtube: "bg-red-500",
  x: "bg-gray-800",
  twitter: "bg-gray-800",
  snapchat: "bg-yellow-400",
  linkedin: "bg-blue-700",
};

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform?.toLowerCase()] || "bg-gray-400";
}

export default function DashboardPage() {
  const { user } = useHrAuth();
  const { data: accountsData } = useAssignedAccounts();
  const { data: reportData } = useTodayReport();

  const accounts = accountsData?.data || [];
  const todayReport = reportData?.data || null;
  const todayLinks = todayReport?.links || [];
  const isSubmitted = !!todayReport;

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {user?.name?.split(" ")[0]}!
        </h1>
        <p className="text-gray-500 mt-1">{today}</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500">Assigned Accounts</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{accounts.length}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500">Today&apos;s Links</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{todayLinks.length}</p>
        </div>
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500">Today&apos;s Status</p>
          <p className={`text-2xl font-bold mt-1 ${isSubmitted ? "text-green-600" : "text-amber-500"}`}>
            {isSubmitted ? "Submitted" : "Pending"}
          </p>
        </div>
      </div>

      {/* Assigned Accounts */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Assigned Accounts</h2>
        {accounts.length === 0 ? (
          <p className="text-gray-400 text-sm">No accounts assigned yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {accounts.map((acc: any) => (
              <div
                key={acc.id}
                className="border border-gray-100 rounded-lg p-4 flex items-start gap-3 hover:shadow-sm transition-shadow"
              >
                <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${getPlatformColor(acc.platform)}`} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 text-sm truncate">{acc.handle || acc.name}</p>
                  <p className="text-xs text-gray-400 capitalize">{acc.platform}</p>
                  {acc.followerCount != null && (
                    <p className="text-xs text-gray-500 mt-1">
                      {acc.followerCount.toLocaleString()} followers
                    </p>
                  )}
                </div>
                {acc.url && (
                  <a href={acc.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 text-gray-400 hover:text-blue-500" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Today's Report */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Today&apos;s Report</h2>
          {!isSubmitted && (
            <Link
              href="/report"
              className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Submit Now
            </Link>
          )}
        </div>
        {!isSubmitted ? (
          <div className="text-center py-8">
            <p className="text-gray-400 text-sm">You haven&apos;t submitted a report yet today.</p>
            <Link href="/report" className="text-blue-600 text-sm mt-2 inline-block hover:underline">
              Go to Submit Report
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {todayLinks.map((link: any, i: number) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getPlatformColor(link.account?.platform)}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{link.account?.handle || link.account?.name}</p>
                  <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline truncate block">
                    {link.url}
                  </a>
                </div>
              </div>
            ))}
            {todayReport?.notes && (
              <div className="mt-3 p-3 bg-yellow-50 rounded-lg">
                <p className="text-xs text-gray-600 font-medium">Notes</p>
                <p className="text-sm text-gray-700 mt-1">{todayReport.notes}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
