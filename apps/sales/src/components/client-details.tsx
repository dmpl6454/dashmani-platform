"use client";
// The client page's "Details" card (read-only). Everything is edited on /clients/edit.
import Link from "next/link";
import type { ClientRow } from "@/lib/sales-types";

export function ClientDetails({ client }: { client: ClientRow }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">Details</h2>
        <Link href={`/clients/edit?id=${client.id}`} className="btn btn-ghost btn-sm">Edit</Link>
      </div>
      <dl className="text-sm grid gap-1">
        <div><dt className="text-ink-4 text-xs">Company</dt><dd>{client.companyName}</dd></div>
        <div><dt className="text-ink-4 text-xs">Contact person</dt><dd>{client.contactName}</dd></div>
        <div><dt className="text-ink-4 text-xs">Email (portal sign-in)</dt><dd className="break-all">{client.email}</dd></div>
        <div><dt className="text-ink-4 text-xs">Phone</dt><dd>{client.phone || "—"}</dd></div>
      </dl>
    </section>
  );
}
