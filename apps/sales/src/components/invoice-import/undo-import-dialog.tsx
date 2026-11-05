"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { ImportListRow, ImportView } from "@/lib/sales-types";
import { Confirm, Field, Toast } from "@/components/sales-ui";
import { int, invalidateAfterImport } from "./shared";

/** Undo a whole import (Admin): its invoices and receipts go; clients and series stay. */
export function UndoImportDialog({ imp, onClose, onDone }: { imp: ImportListRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const go = async () => {
    if (reason.trim().length < 3) { setToast({ message: "Say why in a few words", tone: "err" }); return; }
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/undo`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      await invalidateAfterImport();
      setToast({ message: `Import undone — ${int(imp.counts.imported)} invoices and ${int(imp.counts.payments)} receipts removed. ${int(r.data.counts.clientsCreated)} clients it created are kept.`, tone: "ok" });
      onDone();
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    }
  };
  return (
    <>
      <Confirm danger title="Undo the whole import?" confirmLabel="Undo import" onClose={onClose} onConfirm={go}
        body={<div className="grid gap-3">
          <p>This removes the {int(imp.counts.imported)} invoices and {int(imp.counts.payments)} receipts it created. The {int(imp.counts.clientsCreated)} clients it created stay; invoice series don&apos;t move back.</p>
          <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong file / wrong year / …" /></Field>
        </div>} />
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}
