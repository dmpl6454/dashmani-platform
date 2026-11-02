"use client";
// The client page's "Projects" card: the Pipeline projects linked to this client
// (GET /sales/clients/:id/projects), live first, plus "New project" prefilled with the client.
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { fmtDate } from "@/lib/format";

interface ClientProject {
  id: string;
  title: string;
  phaseName: string;
  phaseColor: string;
  dueDate: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

export function ClientProjects({ clientId }: { clientId: string }) {
  const { data, error, mutate } = useSWR<ClientProject[]>(`/sales/clients/${clientId}/projects`, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="font-bold">Projects</h2>
        <Link href={`/pipeline?new=1&clientId=${clientId}`} className="btn btn-ghost btn-sm">
          New project
        </Link>
      </div>
      {error ? (
        <p className="text-sm text-ink-3">
          Couldn&apos;t load projects.{" "}
          <button type="button" className="underline" onClick={() => mutate()}>
            Try again
          </button>
        </p>
      ) : !data ? (
        <p className="text-sm text-ink-4">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-ink-3">No Pipeline projects for this client yet.</p>
      ) : (
        <ul className="text-sm divide-y divide-rule">
          {data.map((p) => (
            <li key={p.id} className="py-2 min-w-0">
              <Link href={`/pipeline/view?id=${p.id}`} className="font-semibold hover:text-indigo-light block truncate">
                {p.title}
              </Link>
              <div className="text-xs text-ink-3 flex flex-wrap gap-x-2">
                <span>
                  <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ backgroundColor: p.phaseColor || "#888" }} aria-hidden />
                  {p.phaseName}
                </span>
                {p.dueDate && <span>Due {fmtDate(p.dueDate)}</span>}
                {p.archivedAt && <span className="text-ink-4">Archived</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
