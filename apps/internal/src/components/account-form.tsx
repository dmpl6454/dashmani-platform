"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

interface AccountFormProps {
  account?: any;
}

export function AccountForm({ account }: AccountFormProps) {
  const router = useRouter();
  const isEdit = !!account;
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [form, setForm] = useState({
    handle: account?.handle || "",
    displayName: account?.displayName || "",
    platformId: account?.platform?.id || "",
    clientName: account?.clientName || "",
    profileUrl: account?.profileUrl || "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/platforms").then((res: any) => setPlatforms(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload: any = { ...form };
      if (!payload.clientName) delete payload.clientName;
      if (!payload.profileUrl) delete payload.profileUrl;
      if (isEdit) {
        delete payload.platformId;
        await apiFetch(`/accounts/${account.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/accounts", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/accounts");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
      <CardHeader>
        <CardTitle className="font-serif text-[#1A1A1A]">{isEdit ? "Edit Account" : "Add Social Account"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-[#1A1A1A]">Platform</label>
              <select
                className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
                value={form.platformId}
                onChange={(e) => setForm({ ...form, platformId: e.target.value })}
                required
              >
                <option value="">Select platform</option>
                {platforms.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          <Input label="Handle" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="@username" required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          <Input label="Display Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          <Input label="Client Name" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="Optional" className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          <Input label="Profile URL" value={form.profileUrl} onChange={(e) => setForm({ ...form, profileUrl: e.target.value })} placeholder="https://..." className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          <div className="flex gap-3">
            <Button type="submit" disabled={loading} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">{loading ? "Saving..." : isEdit ? "Update" : "Add Account"}</Button>
            <Button type="button" variant="outline" onClick={() => router.back()} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7]">Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
