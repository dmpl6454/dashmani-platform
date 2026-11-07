"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useImport } from "@/lib/hooks";
import type { ImportView } from "@/lib/sales-types";
import { Empty, LoadError, Loading, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { StepStrip } from "@/components/invoice-import/step-strip";
import { ColumnMap } from "@/components/invoice-import/column-map";
import { CheckStep } from "@/components/invoice-import/check-step";
import { ApplyBar } from "@/components/invoice-import/apply-bar";
import { ImportProgress } from "@/components/invoice-import/import-progress";
import { ImportReport } from "@/components/invoice-import/import-report";
import { invalidateAfterImport, stepOf } from "@/components/invoice-import/shared";

/** One Swipe import through all its states (static export: the id comes from ?id=). */
function ImportViewInner() {
  const id = useSearchParams().get("id");
  const { data: imp, error, isLoading, mutate } = useImport(id);
  const lastStatus = useRef<string | null>(null);
  // Toasts raised by a step that unmounts as the status moves on (Import started, Import undone).
  const [toast, setToast] = useState<string | null>(null);
  // Stable, so the 2-second polls while applying don't restart the toast's timer.
  const clearToast = useCallback(() => setToast(null), []);
  // When a run finishes, the invoice, payment, client and dashboard lists all changed.
  useEffect(() => {
    if (lastStatus.current === "applying" && imp && imp.status !== "applying") void invalidateAfterImport();
    lastStatus.current = imp?.status ?? null;
  }, [imp]);
  if (!id) return <Empty title="No import selected." action={<Link href="/invoices/import" className="btn">Back to imports</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !imp) return <Loading />;
  const set = (v: ImportView) => { void mutate(v, { revalidate: false }); };
  return (
    <>
      <PageHead kicker={<><Link href="/invoices" className="hover:text-white">Invoices</Link> · <Link href="/invoices/import" className="hover:text-white">Import old invoices</Link></> as unknown as string}
        title={<span className="break-all">{imp.fileName} <StatusPill status={imp.status} /></span>} />
      <StepStrip step={stepOf(imp)} />
      {imp.status === "draft" && (
        <>
          <ColumnMap imp={imp} onSaved={set} />
          <CheckStep imp={imp} onChanged={set} />
          <ApplyBar imp={imp} onChanged={set} refresh={() => mutate()} notify={setToast} />
        </>
      )}
      {(imp.status === "applying" || imp.status === "failed") && <ImportProgress imp={imp} onChanged={set} refresh={() => mutate()} notify={setToast} />}
      {(imp.status === "applied" || imp.status === "undone") && <ImportReport imp={imp} refresh={() => mutate()} />}
      {toast && <Toast message={toast} onDone={clearToast} />}
    </>
  );
}

export default function ImportViewPage() {
  return <Suspense fallback={<Loading />}><ImportViewInner /></Suspense>;
}
