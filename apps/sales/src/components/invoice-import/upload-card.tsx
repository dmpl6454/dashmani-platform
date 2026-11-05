"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { apiUpload } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { useCompany, companyName } from "@/lib/company";
import { useSeller } from "@/lib/hooks";
import type { ImportView } from "@/lib/sales-types";
import { Field, Toast } from "@/components/sales-ui";

const MAX_BYTES = 5 * 1024 * 1024;

/** Upload a Swipe export for the current company; the check is built in the same request. */
export function UploadCard() {
  const router = useRouter();
  const { company } = useCompany();
  const { data: seller } = useSeller();
  const [file, setFile] = useState<File | null>(null);
  const [registration, setRegistration] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const profile = seller?.profile;
  const regs = profile ? [{ label: profile.city || "Principal", gstin: profile.gstin }, ...(profile.branches ?? []).map((b) => ({ label: b.label, gstin: b.gstin }))].filter((r): r is { label: string; gstin: string } => !!r.gstin) : [];

  const submit = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) { setToast("The file is larger than 5 MB — export one financial year at a time from Swipe"); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("company", company);
      form.append("registration", registration);
      form.append("file", file);
      const r = await apiUpload<ImportView>("/sales/imports", form);
      router.push(`/invoices/import/view?id=${r.data.id}`);
    } catch (err) {
      setToast(errorSentence(err));
      setBusy(false);
    }
  };

  return (
    <section className="card p-4 grid grid-cols-1 gap-3 mb-6">
      <p className="text-sm">Importing into <strong>{companyName(company)}</strong> <span className="text-ink-3">(switch company at the top)</span>.</p>
      <p className="text-sm text-ink-3">In Swipe, export your invoices as Excel or CSV (item-wise is best), one financial year at a time.</p>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 items-end">
        {regs.length > 1 && (
          <Field label="Billed from" hint="If Swipe keeps a separate business per GSTIN, export each one and pick it here.">
            <select className="input" value={registration} onChange={(e) => setRegistration(e.target.value)}>
              <option value="auto">Detect automatically</option>
              {regs.map((r) => <option key={r.gstin} value={r.gstin}>{r.label} · {r.gstin}</option>)}
            </select>
          </Field>
        )}
        <Field label="Swipe export (.csv, .xlsx or .xls)">
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full max-w-full text-[13px] text-ink-2 file:mr-3 file:h-9 file:px-3 file:border-0 file:bg-muted file:text-[12.5px] file:font-semibold file:text-ink" />
        </Field>
      </div>
      <div>
        <button type="button" className="btn" disabled={!file || busy} onClick={submit}><Upload size={14} /> {busy ? "Reading the file…" : "Upload and check"}</button>
      </div>
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </section>
  );
}
