"use client";
import { useTallyDoc } from "@/lib/hooks";
import { StatusPill } from "./sales-ui";
import type { TallyDocType } from "@/lib/sales-types";

// A document's state in Tally, beside its status pill (spec-tally §5.6). Renders nothing until the
// document has been near Tally (never / before the books / Tally not set up).
export function TallyBadge({ docType, docId }: { docType: TallyDocType; docId: string | null | undefined }) {
  const { data } = useTallyDoc(docType, docId ?? null);
  if (!data) return null;
  const pill = (status: string, label: string, title?: string) => (
    <span className="ml-2 align-middle" title={title}><StatusPill status={status} label={label} /></span>
  );
  switch (data.state) {
    case "synced": return pill("synced", `In Tally · #${data.runNo}`);
    case "pending": return pill("changed", `In export #${data.runNo}`);
    case "changed": return pill("changed", "Changed since sent to Tally");
    case "cancelled_in_tally": return pill("unchanged", "Cancelled in Tally");
    case "failed": return pill("failed", "Tally failed", data.error ?? undefined);
    default: return null;
  }
}
