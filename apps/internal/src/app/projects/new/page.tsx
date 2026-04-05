"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

export default function NewProjectPage() {
  const router = useRouter();
  const [clients, setClients] = useState<any[]>([]);
  const [form, setForm] = useState({ name: "", description: "", clientId: "", startDate: "", endDate: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/clients?limit=100").then((res: any) => setClients(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          clientId: form.clientId,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
        }),
      });
      router.push("/projects");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Create New Project</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input label="Project Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <div className="space-y-1">
            <label className="text-sm font-medium">Description</label>
            <textarea className="flex w-full rounded-md border border-border bg-white px-3 py-2 text-sm min-h-[80px]" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Client</label>
            <select className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
              <option value="">Select a client</option>
              {clients.map((c: any) => <option key={c.id} value={c.id}>{c.companyName}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <Input label="End Date" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>{loading ? "Creating..." : "Create Project"}</Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
