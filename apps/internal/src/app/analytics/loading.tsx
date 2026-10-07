// /analytics/* share this loading state. Only /analytics itself is redesigned so far,
// so the skeleton follows the shell the route renders in.
"use client";
import { usePathname } from "next/navigation";
import { isDsRoute } from "@/lib/ds-routes";

export default function Loading() {
  const pathname = usePathname();
  if (isDsRoute(pathname)) {
    return (
      <div className="pt-[26px] space-y-3.5" aria-hidden="true">
        <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        <div className="h-7 w-36 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
          {[...Array(4)].map((_, i) => <div key={i} className="h-[300px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-48 bg-rule rounded-xl" />
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-20 bg-rule rounded-xl" />
        ))}
      </div>
      <div className="h-80 bg-rule rounded-2xl" />
    </div>
  );
}
