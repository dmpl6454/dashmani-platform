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
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Account" : "Add Social Account"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!isEdit && (
            <div className="space-y-1">
              <label className="text-sm font-medium">Platform</label>
              <select
                className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
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
          <Input label="Handle" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} placeholder="@username" required />
          <Input label="Display Name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          <Input label="Client Name" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} placeholder="Optional" />
          <Input label="Profile URL" value={form.profileUrl} onChange={(e) => setForm({ ...form, profileUrl: e.target.value })} placeholder="https://..." />
          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>{loading ? "Saving..." : isEdit ? "Update" : "Add Account"}</Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
