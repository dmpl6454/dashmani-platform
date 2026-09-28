"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

export default function NewClientPage() {
  const router = useRouter();
  const [form, setForm] = useState({ companyName: "", contactName: "", email: "", password: "", phone: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await apiFetch("/clients", { method: "POST", body: JSON.stringify(form) });
      router.push("/clients");
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
          <h3 className="font-serif text-ink font-medium text-lg">Add New Client</h3>
        </div>
        <div className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
            {error && <p className="text-sm text-danger">{error}</p>}
            <Input label="Company Name" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <Input label="Contact Name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <div className="flex gap-3">
              <Button type="submit" disabled={loading} className="bg-action text-[#06121B] rounded-full hover:bg-[#243645]">{loading ? "Creating..." : "Create Client"}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]">Cancel</Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
