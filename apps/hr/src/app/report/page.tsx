"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport } from "@/lib/hooks/use-reports";

interface LinkEntry {
  accountId: string;
  url: string;
  description: string;
  likes: string;
  comments: string;
  shares: string;
  views: string;
  mediaUrl: string;
}

const emptyLink = (): LinkEntry => ({
  accountId: "",
  url: "",
  description: "",
  likes: "",
  comments: "",
  shares: "",
  views: "",
  mediaUrl: "",
});

export default function ReportPage() {
  const router = useRouter();
  const { data: accountsData } = useAssignedAccounts();
  const { data: todayData } = useTodayReport();

  const accounts = accountsData?.data || [];
  const existing = todayData?.data;

  const [links, setLinks] = useState<LinkEntry[]>([emptyLink()]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  const today = new Date().toISOString().split("T")[0];

  // Pre-fill from existing report
  useEffect(() => {
    if (existing && !prefilled) {
      setPrefilled(true);
      setNotes(existing.notes || "");
      if (existing.links?.length > 0) {
        setLinks(
          existing.links.map((l: any) => ({
            accountId: l.accountId || "",
            url: l.url || "",
            description: l.description || "",
            likes: l.engagement?.likes?.toString() || "",
            comments: l.engagement?.comments?.toString() || "",
            shares: l.engagement?.shares?.toString() || "",
            views: l.engagement?.views?.toString() || "",
            mediaUrl: l.mediaUrl || "",
          }))
        );
      }
    }
  }, [existing, prefilled]);

  function updateLink(i: number, field: keyof LinkEntry, value: string) {
    setLinks((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  function addLink() {
    setLinks((prev) => [...prev, emptyLink()]);
  }

  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    let geo: { lat?: number; lng?: number } = {};
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      );
      geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    } catch {
      // geo optional
    }

    try {
      await apiFetch("/hr/reports", {
        method: "POST",
        body: JSON.stringify({
          date: today,
          notes,
          geo,
          links: links
            .filter((l) => l.url)
            .map((l) => ({
              accountId: l.accountId,
              url: l.url,
              description: l.description || undefined,
              mediaUrl: l.mediaUrl || undefined,
              engagement: {
                likes: l.likes ? parseInt(l.likes) : undefined,
                comments: l.comments ? parseInt(l.comments) : undefined,
                shares: l.shares ? parseInt(l.shares) : undefined,
                views: l.views ? parseInt(l.views) : undefined,
              },
            })),
        }),
      });
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Submit Daily Report</h1>
        <p className="text-gray-500 mt-1">Date: {today}</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {links.map((link, i) => (
          <div key={i} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-gray-800">Link #{i + 1}</h3>
              {links.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLink(i)}
                  className="text-red-500 hover:text-red-700 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Account</label>
                <select
                  value={link.accountId}
                  onChange={(e) => updateLink(i, "accountId", e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select account...</option>
                  {accounts.map((acc: any) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.handle || acc.name} ({acc.platform})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">URL *</label>
                <input
                  type="url"
                  value={link.url}
                  onChange={(e) => updateLink(i, "url", e.target.value)}
                  placeholder="https://..."
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
              <input
                type="text"
                value={link.description}
                onChange={(e) => updateLink(i, "description", e.target.value)}
                placeholder="Brief description..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(["likes", "comments", "shares", "views"] as const).map((field) => (
                <div key={field}>
                  <label className="block text-xs font-medium text-gray-600 mb-1 capitalize">{field}</label>
                  <input
                    type="number"
                    min="0"
                    value={link[field]}
                    onChange={(e) => updateLink(i, field, e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Media URL (optional)</label>
              <input
                type="url"
                value={link.mediaUrl}
                onChange={(e) => updateLink(i, "mediaUrl", e.target.value)}
                placeholder="https://..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addLink}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
        >
          <Plus className="h-4 w-4" />
          Add Link
        </button>

        {/* Notes */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <label className="block text-sm font-medium text-gray-700 mb-2">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Any additional notes or observations..."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "Submitting..." : existing ? "Update Report" : "Submit Report"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="px-6 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
