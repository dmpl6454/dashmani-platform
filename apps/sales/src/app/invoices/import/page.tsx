"use client";
import Link from "next/link";
import { PageHead } from "@/components/sales-ui";
import { UploadCard } from "@/components/invoice-import/upload-card";
import { ImportHistory } from "@/components/invoice-import/import-history";

// Invoices → Import old invoices (spec-import §5): upload a Swipe export, then follow it on its own page.
export default function ImportInvoicesPage() {
  return (
    <>
      <PageHead kicker={<Link href="/invoices" className="hover:text-white">Invoices</Link> as unknown as string} title="Import old invoices" />
      <p className="text-sm text-ink-3 mb-4 max-w-3xl">Upload the invoice export from Swipe. The portal checks every invoice against GST arithmetic and your clients; nothing is added until an admin presses Import.</p>
      <UploadCard />
      <h2 className="font-bold mb-3">Imports</h2>
      <ImportHistory />
    </>
  );
}
