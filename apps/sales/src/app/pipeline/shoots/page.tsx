"use client";
/** /pipeline/shoots — the shoot desk (?view=upcoming|mine|past). */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ShootDesk } from "@/components/pipeline/shoots/ShootDesk";
import { GateScreen } from "@/components/pipeline/header/GateScreen";

function Route() {
  const v = useSearchParams().get("view");
  return <ShootDesk initialView={v === "mine" || v === "past" ? v : "upcoming"} />;
}

export default function ShootsPage() {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <Route />
    </Suspense>
  );
}
