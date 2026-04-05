"use client";
import { HrSidebar } from "@/components/hr-sidebar";
import { useHrAuth } from "@/lib/auth";

export default function LeaderboardLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useHrAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="flex min-h-screen">
      <HrSidebar />
      <main className="flex-1 bg-gray-50 p-6">{children}</main>
    </div>
  );
}
