"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

interface ContentFormProps {
  content?: any;
}

export function ContentForm({ content }: ContentFormProps) {
  const router = useRouter();
  const isEdit = !!content;
  const [projects, setProjects] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({
    title: content?.title || "",
    caption: content?.caption || "",
    projectId: content?.project?.id || "",
    accountId: content?.account?.id || "",
    scheduledAt: content?.scheduledAt ? content.scheduledAt.slice(0, 16) : "",
    mediaUrls: content?.mediaUrls?.join("\n") || "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/projects?limit=100").then((res: any) => setProjects(res.data || []));
    apiFetch("/accounts?limit=100").then((res: any) => setAccounts(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const mediaUrls = form.mediaUrls
        .split("\n")
        .map((u: string) => u.trim())
        .filter((u: string) => u.length > 0);

      const payload: any = {
        title: form.title,
        caption: form.caption || undefined,
        projectId: form.projectId,
        accountId: form.accountId || undefined,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      };

      if (isEdit) {
        await apiFetch(`/content/${content.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/content", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/content");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
      <CardHeader>
        <CardTitle className="font-serif text-[#1A1A1A]">{isEdit ? "Edit Content Post" : "Create New Content Post"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input
            label="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
            className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Caption</label>
            <textarea
              className="flex w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm min-h-[100px] focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={form.caption}
              onChange={(e) => setForm({ ...form, caption: e.target.value })}
              placeholder="Write the post caption/body..."
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Project *</label>
            <select
              className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={form.projectId}
              onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              required
            >
              <option value="">Select a project</option>
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.client?.companyName})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Social Account</label>
            <select
              className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            >
              <option value="">None (select later)</option>
              {accounts.map((acc: any) => (
                <option key={acc.id} value={acc.id}>
                  {acc.platform?.name}: {acc.handle}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Scheduled Date/Time"
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
            className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Media URLs (one per line)</label>
            <textarea
              className="flex w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={form.mediaUrls}
              onChange={(e) => setForm({ ...form, mediaUrls: e.target.value })}
              placeholder={"https://example.com/image1.jpg\nhttps://example.com/image2.jpg"}
            />
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={loading} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {loading ? "Saving..." : isEdit ? "Update Content" : "Create Content"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7]">
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
