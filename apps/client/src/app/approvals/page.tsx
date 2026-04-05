"use client";
import { useState } from "react";
import { useClientApprovals } from "@/lib/hooks/use-projects";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, Badge, Button } from "@dashmani/ui";
import { mutate } from "swr";

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<string>("");
  const { data, isLoading } = useClientApprovals({ status: filter });
  const approvals = (data as any)?.data || [];
  const [responding, setResponding] = useState<string | null>(null);

  async function respond(id: string, status: string, note?: string) {
    setResponding(id);
    try {
      await apiFetch(`/client/approvals/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status, clientNote: note }),
      });
      mutate((key: string) => typeof key === "string" && key.includes("/client/approvals"), undefined, { revalidate: true });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setResponding(null);
    }
  }

  const statusColor: Record<string, "default" | "secondary" | "warning" | "danger"> = {
    PENDING: "warning", APPROVED: "default", REJECTED: "danger", REVISION_REQUESTED: "warning",
  };

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Approvals</h2>
      <div className="flex gap-2">
        {["", "PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded-full text-sm ${filter === s ? "bg-brand-blue text-white" : "bg-gray-100 text-gray-600"}`}
          >
            {s || "All"}
          </button>
        ))}
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : approvals.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No approvals found.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {approvals.map((a: any) => (
            <Card key={a.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-sm text-muted-foreground">{a.project?.name}</p>
                    {a.description && <p className="text-sm mt-1">{a.description}</p>}
                    {a.fileUrl && (
                      <a href={a.fileUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-blue underline mt-1 block">View Attachment</a>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">Requested by {a.requestedBy?.name}</p>
                  </div>
                  <Badge variant={statusColor[a.status]}>{a.status?.replace("_", " ")}</Badge>
                </div>
                {a.status === "PENDING" && (
                  <div className="flex gap-2 mt-4">
                    <Button size="sm" onClick={() => respond(a.id, "APPROVED")} disabled={responding === a.id}>Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => respond(a.id, "REVISION_REQUESTED", "Please revise")} disabled={responding === a.id}>Request Revision</Button>
                    <Button size="sm" variant="outline" onClick={() => respond(a.id, "REJECTED", "Not approved")} disabled={responding === a.id}>Reject</Button>
                  </div>
                )}
                {a.clientNote && <p className="text-sm mt-2 p-2 bg-gray-50 rounded">Note: {a.clientNote}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
