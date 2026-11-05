"use client";
import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { useImports } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { ImportListRow } from "@/lib/sales-types";
import { Empty, LoadError, Loading, Money, StatusPill } from "@/components/sales-ui";
import { UndoImportDialog } from "./undo-import-dialog";
import { int } from "./shared";

/** Every Swipe import of the current company: open it, or undo an applied one (Admin). */
export function ImportHistory() {
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data, error, isLoading, mutate } = useImports();
  const [undo, setUndo] = useState<ImportListRow | null>(null);
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading />;
  if (!data?.length) return <Empty title="No imports yet." body="Export your invoices from Swipe as CSV or Excel — one financial year at a time works best — and upload the file here." />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
          <tr className="border-b-2 border-border"><th className="p-3">Uploaded</th><th className="p-3">File</th><th className="p-3">Status</th><th className="p-3 text-right">Invoices</th><th className="p-3 text-right">Total</th><th className="p-3">By</th><th className="p-3" /></tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id} className="border-b border-rule">
              <td className="p-3 whitespace-nowrap">{fmtDate(r.createdAt.slice(0, 10))}</td>
              <td className="p-3 max-w-[260px] truncate" title={r.fileName}>{r.fileName}</td>
              <td className="p-3"><StatusPill status={r.status} /></td>
              <td className="p-3 text-right whitespace-nowrap">{int(r.counts.imported)} / {int(r.counts.found)}</td>
              <td className="p-3 text-right"><Money paise={r.totalPaise} whole /></td>
              <td className="p-3 truncate max-w-[160px]">{r.createdByName ?? "—"}</td>
              <td className="p-3 whitespace-nowrap text-right">
                <Link href={`/invoices/import/view?id=${r.id}`} className="btn btn-ghost btn-sm">Open</Link>
                {admin && r.undo?.allowed && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUndo(r)}>Undo</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {undo && <UndoImportDialog imp={undo} onClose={() => setUndo(null)} onDone={() => { setUndo(null); mutate(); }} />}
    </div>
  );
}
