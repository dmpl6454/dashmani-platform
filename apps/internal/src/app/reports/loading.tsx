// /reports/* share this loading state. Only /reports itself is redesigned so far,
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
        <div className="h-7 w-44 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        <div className="h-[92px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
          {[...Array(5)].map((_, i) => <div key={i} className="h-[112px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
        </div>
        <div className="h-80 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
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
