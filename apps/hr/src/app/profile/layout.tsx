"use client";
import { PortalShell } from "@/components/portal-shell";

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
