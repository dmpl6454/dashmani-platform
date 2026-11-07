"use client";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { useSeller } from "@/lib/hooks";
import type { ImportFieldKey, ImportOptions, ImportView, MappingHow } from "@/lib/sales-types";
import { Field, Toast } from "@/components/sales-ui";
import { FIELD_GROUPS, REQUIRED_FIELDS, int } from "./shared";

const BADGE: Record<MappingHow, string> = { auto: "Auto", check: "Auto · check", user: "Set by you", previous: "From your last import", missing: "" };

/**
 * The Columns card: which column of the file fills which field, plus the reading options. Collapsed
 * while all is well; opens itself when a blocker is about columns or a field needs checking.
 */
export function ColumnMap({ imp, onSaved }: { imp: ImportView; onSaved: (v: ImportView) => void }) {
  const { data: seller } = useSeller(imp.companyKey);
  const [mapping, setMapping] = useState(imp.mapping);
  const [options, setOptions] = useState<ImportOptions>(imp.options);
  const [headerRow, setHeaderRow] = useState(imp.file.headerRow);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => { setMapping(imp.mapping); setOptions(imp.options); setHeaderRow(imp.file.headerRow); }, [imp.planHash, imp.mapping, imp.options, imp.file.headerRow]);

  const all = FIELD_GROUPS.flatMap((g) => g.fields.map(([f]) => f));
  const matched = all.filter((f) => mapping[f] !== null && mapping[f] !== undefined).length;
  const needsCheck = all.some((f) => imp.mappingHow[f] === "check");
  const columnBlocker = imp.summary?.blockers.some((b) => ["REQUIRED_FIELD_UNMAPPED", "DATE_ORDER_CONFLICT", "PAID_TDS_AMBIGUOUS"].includes(b.code)) ?? false;
  const dirty = useMemo(() => JSON.stringify(mapping) !== JSON.stringify(imp.mapping) || JSON.stringify(options) !== JSON.stringify(imp.options) || headerRow !== imp.file.headerRow, [mapping, options, headerRow, imp]);
  const profile = seller?.profile;
  const regs = profile ? [{ label: profile.city || "Principal", gstin: profile.gstin }, ...(profile.branches ?? []).map((b) => ({ label: b.label, gstin: b.gstin }))].filter((r): r is { label: string; gstin: string } => !!r.gstin) : [];

  const save = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/mapping`, { method: "PUT", body: JSON.stringify({ headerRow, mapping, options }) });
      onSaved(r.data);
      setToast({ message: `Check updated — ${int(r.data.counts.ready)} invoices ready`, tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const used = new Map<number, ImportFieldKey>();
  for (const [f, c] of Object.entries(mapping)) if (c !== null && c !== undefined) used.set(c, f as ImportFieldKey);

  return (
    <details className="card p-4 mb-4" open={columnBlocker || needsCheck || undefined}>
      <summary className="cursor-pointer font-bold">Columns: {matched} of {all.length} matched — change</summary>
      <div className="grid grid-cols-1 gap-4 mt-4">
        {FIELD_GROUPS.map((g) => (
          <section key={g.title} className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <h3 className="sm:col-span-2 text-[11px] uppercase tracking-[0.12em] text-ink-3">{g.title}</h3>
            {g.fields.map(([f, label]) => {
              const col = mapping[f] ?? null;
              const how = imp.mappingHow[f];
              const samples = col !== null ? imp.columns[col]?.samples ?? [] : [];
              return (
                <Field key={f} label={`${label}${REQUIRED_FIELDS.has(f) ? " *" : ""}`} hint={samples.length ? samples.join(" · ") : undefined}>
                  <div className="flex gap-2 items-center min-w-0">
                    <select className="input min-w-0 flex-1" value={col === null ? "" : String(col)} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === "" ? null : Number(e.target.value) })}>
                      <option value="">— not in the file —</option>
                      {imp.columns.map((c) => <option key={c.index} value={c.index} disabled={used.has(c.index) && used.get(c.index) !== f}>{c.header || `Column ${c.index + 1}`}{c.samples[0] ? ` — e.g. ${c.samples[0]}` : ""}</option>)}
                    </select>
                    {how && BADGE[how] && col === imp.mapping[f] && <span className={`text-[11px] whitespace-nowrap ${how === "check" ? "text-attention" : "text-ink-3"}`}>{BADGE[how]}</span>}
                  </div>
                </Field>
              );
            })}
          </section>
        ))}
        <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Headings are on row"><input className="input" type="number" min={1} max={30} value={headerRow} onChange={(e) => setHeaderRow(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} /></Field>
          <Field label="Dates are" hint={imp.summary ? `Read as ${imp.summary.dateOrder === "dmy" ? "day-month-year" : "month-day-year"}` : undefined}>
            <select className="input" value={options.dateOrder} onChange={(e) => setOptions({ ...options, dateOrder: e.target.value as ImportOptions["dateOrder"] })}>
              <option value="auto">Detect</option><option value="dmy">day-month-year</option><option value="mdy">month-day-year</option>
            </select>
          </Field>
          <Field label="Amounts are" hint={imp.summary?.amountLevels.taxable ? `Taxable read per ${imp.summary.amountLevels.taxable === "line" ? "item" : "invoice"}` : undefined}>
            <select className="input" value={options.amountLevel} onChange={(e) => setOptions({ ...options, amountLevel: e.target.value as ImportOptions["amountLevel"] })}>
              <option value="auto">Detect</option><option value="line">per item</option><option value="invoice">per invoice</option>
            </select>
          </Field>
          {mapping.tds !== null && mapping.tds !== undefined && (
            <Field label="Amount Paid includes TDS">
              <select className="input" value={options.paidIncludesTds} onChange={(e) => setOptions({ ...options, paidIncludesTds: e.target.value as ImportOptions["paidIncludesTds"] })}>
                <option value="auto">Detect</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </Field>
          )}
          {regs.length > 1 && (
            <Field label="Billed from">
              <select className="input" value={options.registration} onChange={(e) => setOptions({ ...options, registration: e.target.value })}>
                <option value="auto">Detect</option>
                {regs.map((r) => <option key={r.gstin} value={r.gstin}>{r.label} · {r.gstin}</option>)}
              </select>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input type="checkbox" checked={options.fillMissingProfiles} onChange={(e) => setOptions({ ...options, fillMissingProfiles: e.target.checked })} />
            Fill missing billing profiles of matched clients from the file
          </label>
        </section>
        {dirty && <div><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? "Checking…" : "Save columns and check again"}</button></div>}
      </div>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </details>
  );
}
