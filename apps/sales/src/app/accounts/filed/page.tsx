"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import {
  ENTRY_UNIT_LABELS,
  FILED_FIGURES,
  FILED_FIGURE_KEYS,
  filedChecks,
  fyBounds,
  type EntryUnit,
  type FiledFigureKey,
} from "@dashmani/shared/src/sales/accounts";
import { useEvents, useFiledYears } from "@/lib/hooks";
import { isCompanyKey, SALES_COMPANIES, useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch, ApiError } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { downloadFiledPdf, viewFiledPdf } from "@/lib/filed-pdf";
import { fmtDate, todayIST } from "@/lib/format";
import type { FiledFile, FiledYearView } from "@/lib/sales-types";
import { Confirm, Empty, Field, LoadError, Loading, PageHead, SignedAmountInput, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";

// /accounts/filed?fy=2025-26&company=dspl (spec-accounts §5.3): the 12 key figures typed from a
// company's signed balance sheet + P&L for one CLOSED year, plus its signed PDFs (stored in the
// database, never on the public file server). Admins edit; everyone else reads.

const UNITS: EntryUnit[] = ["rupees", "thousands", "lakhs", "crores"];
const KIND_LABELS: Record<string, string> = { accounts: "Signed balance sheet & P&L", audit_report: "Auditor's report", other: "Other" };
const MAX_PDF = 10 * 1024 * 1024;
const blankFigures = () => Object.fromEntries(FILED_FIGURE_KEYS.map((k) => [k, null])) as Record<FiledFigureKey, number | null>;
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function FiledEditor() {
  const params = useSearchParams();
  const router = useRouter();
  const { company: current } = useCompany();
  const q = params.get("company");
  const company = isCompanyKey(q) ? q : current;
  const fy = params.get("fy") ?? "";
  const bounds = fyBounds(fy);
  const { user } = useAuth();
  const canEdit = isAdminUser(user);
  const { data: years, error, mutate } = useFiledYears(company);
  const { mutate: globalMutate } = useSWRConfig();
  const filed: FiledYearView | null = years?.find((y) => y.fy === fy) ?? null;
  const { data: events, mutate: mutateEvents } = useEvents("filed_year", filed?.id ?? null);

  const [unit, setUnit] = useState<EntryUnit>("rupees");
  const [notes, setNotes] = useState("");
  const [figures, setFigures] = useState<Record<FiledFigureKey, number | null>>(blankFigures);
  const [loadedFrom, setLoadedFrom] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const [kind, setKind] = useState("accounts");
  const [uploading, setUploading] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FiledFile | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Load the form from the saved row once per version (a save or another admin's save re-loads it).
  useEffect(() => {
    if (!years) return;
    const stamp = filed?.updatedAt ?? null;
    if (stamp === loadedFrom) return;
    setLoadedFrom(stamp);
    setUnit(filed?.enteredIn ?? "rupees");
    setNotes(filed?.notes ?? "");
    setFigures(filed ? { ...blankFigures(), ...filed.figures } : blankFigures());
  }, [years, filed, loadedFrom]);

  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (!years) return <Loading />;
  const back = <Link href={`/accounts?fy=${fy}`} className="btn btn-ghost">Back to accounts</Link>;
  if (!bounds) return <Empty title="Pick a financial year like 2025-26." action={back} />;
  if (bounds.endDay >= todayIST()) return <Empty title={`${fy} is still running — come back after ${fmtDate(bounds.endDay)}.`} action={back} />;
  const endYear = bounds.endDay.slice(0, 4);
  const checks = filedChecks(figures, unit);
  const refresh = () => globalMutate((k) => typeof k === "string" && k.startsWith("/sales/accounts"), undefined, { revalidate: true });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { ...figures, enteredIn: unit, notes: notes.trim() || null, baseUpdatedAt: filed?.updatedAt ?? null };
      const r = await apiFetch<{ filed: FiledYearView; changed: boolean }>(`/sales/accounts/filed/${fy}?company=${company}`, { method: "PUT", body: JSON.stringify(body) });
      await refresh();
      setToast({ message: r.data.changed ? `Filed figures for ${fy} saved.` : "Nothing changed.", tone: "ok" });
      router.replace(`/accounts?fy=${fy}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      if (err instanceof ApiError && err.code === "FILED_CHANGED") await mutate();
    } finally {
      setSaving(false);
    }
  }

  async function attach(file: File) {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) { setToast({ message: "That file isn't a PDF. Save the signed accounts as a PDF and attach that.", tone: "err" }); return; }
    if (file.size > MAX_PDF) { setToast({ message: "That PDF is larger than 10 MB. Save a smaller copy (print to PDF, or scan at 150 dpi) and attach that.", tone: "err" }); return; }
    setUploading(file.name);
    try {
      const qs = new URLSearchParams({ company, kind, name: file.name });
      const r = await apiFetch<{ file: FiledFile; duplicate: boolean }>(`/sales/accounts/filed/${fy}/files?${qs}`, { method: "POST", body: file, headers: { "Content-Type": "application/pdf" } });
      setToast({ message: r.data.duplicate ? `That PDF is already attached to ${fy}.` : "Signed PDF attached.", tone: "ok" });
      await refresh();
      await mutateEvents();
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const group = (g: "pl" | "bs") => FILED_FIGURES.filter((f) => f.group === g).map((f) => (
    <Field key={f.key} label={f.label}>
      <SignedAmountInput label={f.label} unit={unit} paise={figures[f.key]} signLabels={f.signLabels} disabled={!canEdit}
        onChange={(p) => setFigures((prev) => ({ ...prev, [f.key]: p }))} />
    </Field>
  ));

  return (
    <>
      <PageHead kicker={`${SALES_COMPANIES[company].short} · Filed accounts`} title={`Financial year ${fy}`}>{back}</PageHead>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0 grid grid-cols-[minmax(0,1fr)] gap-4">
          {!canEdit && <div className="card p-3 text-sm">Only an admin can change filed accounts. You can view and download the signed PDF.</div>}
          <form onSubmit={save}>
            <fieldset disabled={!canEdit} className="grid grid-cols-[minmax(0,1fr)] gap-6 min-w-0 border-0 p-0 m-0">
              <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Typing figures in" hint="Match the unit printed at the top of the signed statements">
                  <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as EntryUnit)}>
                    {UNITS.map((u) => <option key={u} value={u}>{ENTRY_UNIT_LABELS[u]}</option>)}
                  </select>
                </Field>
                <Field label="Notes"><textarea className="input min-h-[42px]" rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              </section>
              <section className="card p-4">
                <h2 className="font-bold mb-3">Statement of profit and loss · {fy}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">{group("pl")}</div>
              </section>
              <section className="card p-4">
                <h2 className="font-bold mb-3">Balance sheet at 31 March {endYear}</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">{group("bs")}</div>
                <p className="text-xs text-ink-4 mt-3">&quot;Total liabilities&quot; excludes equity.</p>
              </section>
              {checks.length > 0 && <div className="card border-attention p-3 text-sm space-y-1">{checks.map((c) => <p key={c}>{c}</p>)}</div>}
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className="btn" disabled={saving}>{saving ? "Saving…" : "Save filed figures"}</button>
                  <Link href={`/accounts?fy=${fy}`} className="btn btn-ghost">Cancel</Link>
                </div>
              )}
            </fieldset>
          </form>

          <section className="card p-4 min-w-0">
            <h2 className="font-bold mb-3">Signed PDFs</h2>
            {!filed?.files.length ? <p className="text-sm text-ink-3 mb-3">No PDF attached yet.</p> : (
              <ul className="text-sm divide-y divide-rule mb-3">
                {filed.files.map((f) => (
                  <li key={f.id} className="py-2 flex flex-wrap items-center justify-between gap-2 min-w-0">
                    <span className="min-w-0 break-all">{KIND_LABELS[f.kind] ?? f.kind} · {f.fileName} <span className="text-ink-3">· {size(f.sizeBytes)} · {fmtDate(f.createdAt)}</span></span>
                    <span className="flex gap-2 shrink-0">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => viewFiledPdf(f.id, (m) => setToast({ message: m, tone: "err" }))}>View</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => downloadFiledPdf(f.id, f.fileName, (m) => setToast({ message: m, tone: "err" }))}>Download</button>
                      {canEdit && <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setRemoving(f)}>Remove</button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="flex flex-wrap gap-2 items-end">
                <Field label="What is it?">
                  <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!uploading}>
                    {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
                <label className={`btn btn-light ${uploading ? "opacity-60 pointer-events-none" : "cursor-pointer"}`}>
                  {uploading ? `Uploading ${uploading}…` : "Attach signed PDF"}
                  <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="sr-only" disabled={!!uploading}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); }} />
                </label>
              </div>
            )}
            <p className="text-xs text-ink-4 mt-3">Stored in the database, never on the public file server.</p>
          </section>
        </div>
        <EventList events={filed ? events : []} />
      </div>
      {removing && (
        <Confirm danger title="Remove this PDF?" confirmLabel="Remove PDF" onClose={() => setRemoving(null)}
          body={`${removing.fileName} (${size(removing.sizeBytes)}) will be deleted from the portal. The history keeps its name and fingerprint.`}
          onConfirm={async () => {
            try {
              await apiFetch(`/sales/accounts/filed/files/${removing.id}`, { method: "DELETE" });
              setToast({ message: "PDF removed.", tone: "ok" });
              await refresh();
              await mutateEvents();
            } catch (err) {
              setToast({ message: errorSentence(err), tone: "err" });
            } finally {
              setRemoving(null);
            }
          }} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function FiledPage() {
  return (
    <Suspense fallback={<Loading />}>
      <FiledEditor />
    </Suspense>
  );
}
