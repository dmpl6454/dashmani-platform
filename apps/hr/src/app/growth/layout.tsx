"use client";
import { TopNav } from "@/components/top-nav";
import { useHrAuth } from "@/lib/auth";

export default function GrowthLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useHrAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ background: "var(--crx-bg-gradient)" }}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen" style={{ background: "var(--crx-bg-gradient)" }}>
      <TopNav />
      <main className="max-w-[1440px] mx-auto px-4 md:px-8 py-6">
        {children}
      </main>
    </div>
  );
}
