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
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="font-serif text-[#1A1A1A] font-medium text-lg">Add New Client</h3>
        </div>
        <div className="p-6">
          <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
            {error && <p className="text-sm text-[#E74C3C]">{error}</p>}
            <Input label="Company Name" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <Input label="Contact Name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <div className="flex gap-3">
              <Button type="submit" disabled={loading} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">{loading ? "Creating..." : "Create Client"}</Button>
              <Button type="button" variant="outline" onClick={() => router.back()} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Cancel</Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
