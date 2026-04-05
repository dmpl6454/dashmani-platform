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
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Content Post" : "Create New Content Post"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input
            label="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <div className="space-y-1">
            <label className="text-sm font-medium">Caption</label>
            <textarea
              className="flex w-full rounded-md border border-border bg-white px-3 py-2 text-sm min-h-[100px]"
              value={form.caption}
              onChange={(e) => setForm({ ...form, caption: e.target.value })}
              placeholder="Write the post caption/body..."
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Project *</label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
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
            <label className="text-sm font-medium">Social Account</label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
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
          />
          <div className="space-y-1">
            <label className="text-sm font-medium">Media URLs (one per line)</label>
            <textarea
              className="flex w-full rounded-md border border-border bg-white px-3 py-2 text-sm min-h-[80px]"
              value={form.mediaUrls}
              onChange={(e) => setForm({ ...form, mediaUrls: e.target.value })}
              placeholder={"https://example.com/image1.jpg\nhttps://example.com/image2.jpg"}
            />
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : isEdit ? "Update Content" : "Create Content"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
