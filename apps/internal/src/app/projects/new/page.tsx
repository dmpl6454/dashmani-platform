"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@dashmani/ui";
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
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      setError("End date cannot be earlier than start date.");
      return;
    }
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
    <div className="crx-animate-fade">
      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-serif text-ink font-medium text-lg">Create New Project</h3>
        </div>
        <div className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
            {error && <p className="text-sm text-danger">{error}</p>}
            <Input label="Project Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <div className="space-y-1">
              <label className="text-sm font-medium text-ink">Description</label>
              <textarea className="flex w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-action focus:border-action outline-none" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-ink">Client</label>
              <select className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-action focus:border-action outline-none" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
                <option value="">Select a client</option>
                {clients.map((c: any) => <option key={c.id} value={c.id}>{c.companyName}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Start Date" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate && form.endDate < e.target.value ? "" : form.endDate })} className="min-w-0 h-auto border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
              <Input label="End Date" type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="min-w-0 h-auto border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={loading} className="bg-action text-[#06121B] rounded-full hover:bg-[#243645]">{loading ? "Creating..." : "Create Project"}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]">Cancel</Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
