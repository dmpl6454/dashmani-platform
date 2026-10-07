// /projects/* share this loading state. Only /projects itself is redesigned so far,
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
        <div className="h-[42px] w-[480px] max-w-full rounded-full bg-ds-hover motion-safe:animate-pulse" />
        <div className="h-80 rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      </div>
    );
  }
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-48 bg-rule rounded-xl" />
      <div className="h-80 bg-rule rounded-2xl" />
    </div>
  );
}
