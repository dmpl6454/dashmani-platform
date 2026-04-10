"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, AlertTriangle, FileText, Link2, MessageSquare, BarChart3, Send, Loader2, ChevronDown, Hash, Eye, Heart, Share2 } from "lucide-react";
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

const MAX_LINKS = 500;
const MAX_LINKS_PER_ACCOUNT = 100;

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

const PLATFORM_ACCENT: Record<string, string> = {
  instagram: "border-l-pink-400",
  twitter: "border-l-sky-400",
  x: "border-l-gray-700",
  linkedin: "border-l-blue-600",
  facebook: "border-l-blue-500",
  youtube: "border-l-red-500",
  google: "border-l-green-500",
  snapchat: "border-l-yellow-400",
};

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-all duration-200";
const selectClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-all duration-200 appearance-none";

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
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [accountLimitWarning, setAccountLimitWarning] = useState("");
  const [bulkUrls, setBulkUrls] = useState("");
  const [showBulkAdd, setShowBulkAdd] = useState(false);
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  const today = new Date().toISOString().split("T")[0];
  const todayFormatted = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

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
            likes: l.likes?.toString() || "",
            comments: l.comments?.toString() || "",
            shares: l.shares?.toString() || "",
            views: l.views?.toString() || "",
            mediaUrl: l.mediaUrl || "",
          }))
        );
      }
    }
  }, [existing, prefilled]);

  useEffect(() => {
    const urls = links.map((l) => l.url.trim().toLowerCase()).filter(Boolean);
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const url of urls) {
      if (seen.has(url)) dups.push(url);
      seen.add(url);
    }
    if (dups.length > 0) {
      setDuplicateWarning(`Duplicate URLs detected: ${dups.slice(0, 3).join(", ")}`);
    } else {
      setDuplicateWarning("");
    }
  }, [links]);

  // Per-account 100 links limit check
  useEffect(() => {
    const accountCounts = new Map<string, number>();
    for (const link of links) {
      if (link.accountId && link.url.trim()) {
        accountCounts.set(link.accountId, (accountCounts.get(link.accountId) || 0) + 1);
      }
    }
    const overLimit: string[] = [];
    for (const [accountId, count] of accountCounts) {
      if (count > MAX_LINKS_PER_ACCOUNT) {
        const acc = accounts.find((a: any) => a.id === accountId);
        overLimit.push(`${acc?.handle || acc?.displayName || "Unknown"} (${count}/${MAX_LINKS_PER_ACCOUNT})`);
      }
    }
    if (overLimit.length > 0) {
      setAccountLimitWarning(`Account limit exceeded: ${overLimit.join(", ")} — max ${MAX_LINKS_PER_ACCOUNT} links per account`);
    } else {
      setAccountLimitWarning("");
    }
  }, [links, accounts]);

  function updateLink(i: number, field: keyof LinkEntry, value: string) {
    setLinks((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }

  function addLink() {
    if (links.length >= MAX_LINKS) return;
    setLinks((prev) => [...prev, emptyLink()]);
  }

  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i));
  }

  function getAccountPlatform(accountId: string): string {
    const acc = accounts.find((a: any) => a.id === accountId);
    return (acc?.platform || "").toLowerCase();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const validLinks = links.filter((l) => l.url.trim());
    if (validLinks.length === 0) {
      setError("At least one link is required");
      return;
    }
    const missingAccount = validLinks.find((l) => !l.accountId);
    if (missingAccount) {
      setError("Please select an account for every link before submitting");
      return;
    }
    if (duplicateWarning) {
      setError("Please remove duplicate links before submitting");
      return;
    }
    if (accountLimitWarning) {
      setError("Please reduce links to max 100 per account before submitting");
      return;
    }
    setLoading(true);
    let geo: { latitude?: number; longitude?: number } = {};
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      );
      geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch { /* geo optional */ }
    try {
      await apiFetch("/hr/reports", {
        method: "POST",
        body: JSON.stringify({
          date: today,
          notes,
          ...geo,
          links: validLinks.map((l) => ({
            accountId: l.accountId,
            url: l.url.trim(),
            platform: accounts.find((a: any) => a.id === l.accountId)?.platform || "unknown",
            description: l.description || undefined,
            mediaUrl: l.mediaUrl || undefined,
            likes: l.likes ? parseInt(l.likes) : undefined,
            comments: l.comments ? parseInt(l.comments) : undefined,
            shares: l.shares ? parseInt(l.shares) : undefined,
            views: l.views ? parseInt(l.views) : undefined,
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

  const validLinkCount = links.filter((l) => l.url.trim()).length;

  return (
    <div className="max-w-3xl mx-auto space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center shadow-[0_2px_8px_rgba(245,213,71,0.2)]">
              <FileText className="h-4.5 w-4.5 text-[#B8960C]" />
            </div>
            <h1 className="text-3xl font-light text-[#1A1A1A] font-serif">Daily Report</h1>
          </div>
          <p className="text-[#7A7A7A] text-sm">{todayFormatted}</p>
        </div>
        <div className="text-right space-y-1">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${
            links.length >= MAX_LINKS ? "bg-red-50 text-red-600 border border-red-100" : "bg-[#FFF3C4] text-[#1A1A1A] border border-[#F5D547]/20"
          }`}>
            <Hash className="h-3.5 w-3.5" />
            {validLinkCount} / {MAX_LINKS} links
          </span>
          <p className="text-[10px] text-[#B0B0B0]">Max {MAX_LINKS_PER_ACCOUNT} per account</p>
        </div>
      </div>

      {/* Warnings */}
      {duplicateWarning && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-amber-700">{duplicateWarning}</p>
        </div>
      )}

      {accountLimitWarning && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
          <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-600">{accountLimitWarning}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Quick Bulk Add */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-[#E8E0D0] p-4 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-shadow">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => setShowBulkAdd((v) => !v)} className="text-sm font-medium text-[#1A1A1A] hover:text-[#B8960C] transition-colors flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-[#FFF3C4] flex items-center justify-center">
                <Plus className="h-3.5 w-3.5 text-[#B8960C]" />
              </div>
              Quick Add Multiple Links
              <ChevronDown className={`h-3.5 w-3.5 text-[#B0B0B0] transition-transform duration-200 ${showBulkAdd ? "rotate-180" : ""}`} />
            </button>
            {accounts.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-[#7A7A7A]">Default Account:</label>
                <select value={defaultAccountId} onChange={(e) => setDefaultAccountId(e.target.value)} className="border border-[#E8E0D0] bg-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#F5D547] transition-all">
                  <option value="">None</option>
                  {accounts.map((acc: any) => (
                    <option key={acc.id} value={acc.id}>{acc.handle || acc.displayName} ({acc.platform})</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {showBulkAdd && (
            <div className="space-y-2 mt-3 pt-3 border-t border-[#F0EAD8]" style={{ animation: "crx-slideDown 0.2s ease-out" }}>
              <textarea value={bulkUrls} onChange={(e) => setBulkUrls(e.target.value)} rows={3} placeholder="Paste URLs here, one per line..." className={inputClass + " resize-none text-xs"} />
              <button type="button" onClick={() => {
                const urls = bulkUrls.split("\n").map((u) => u.trim()).filter((u) => u.startsWith("http"));
                if (urls.length === 0) return;
                const newLinks = urls.map((url) => ({ ...emptyLink(), url, accountId: defaultAccountId }));
                setLinks((prev) => {
                  const hasEmpty = prev.length === 1 && !prev[0].url.trim();
                  return hasEmpty ? newLinks : [...prev, ...newLinks];
                });
                setBulkUrls("");
                setShowBulkAdd(false);
              }} className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all shadow-sm hover:shadow-md">
                Add {bulkUrls.split("\n").filter((u) => u.trim().startsWith("http")).length} Links
              </button>
            </div>
          )}
        </div>

        {/* Section header for links */}
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-[#B8960C]" />
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Post Links</h2>
          <div className="flex-1 h-px bg-[#E8E0D0]" />
        </div>

        {/* Link entries */}
        {links.map((link, i) => {
          const platform = getAccountPlatform(link.accountId);
          const accentClass = PLATFORM_ACCENT[platform] || "border-l-[#E8E0D0]";
          return (
            <div
              key={i}
              className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-[#E8E0D0] border-l-[3px] ${accentClass} p-4 space-y-3 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all duration-200`}
              style={{ animation: "crx-slideUp 0.3s ease-out" }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="h-6 w-6 rounded-md bg-[#F7ECD5] flex items-center justify-center text-xs font-semibold text-[#7A7A7A]">{i + 1}</span>
                  <h3 className="font-medium text-[#1A1A1A] text-sm">Link #{i + 1}</h3>
                  {platform && <span className="text-[10px] uppercase tracking-wider text-[#B0B0B0] font-medium">{platform}</span>}
                </div>
                {links.length > 1 && (
                  <button type="button" onClick={() => removeLink(i)} className="text-[#B0B0B0] hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-red-50">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-3">
                <div className="relative">
                  <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Account</label>
                  <select value={link.accountId} onChange={(e) => updateLink(i, "accountId", e.target.value)} className={selectClass}>
                    <option value="">Select account...</option>
                    {accounts.map((acc: any) => (
                      <option key={acc.id} value={acc.id}>{acc.handle || acc.displayName} ({acc.platform})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#7A7A7A] mb-1">URL *</label>
                  <input type="url" value={link.url} onChange={(e) => updateLink(i, "url", e.target.value)} placeholder="https://instagram.com/p/..." required className={inputClass} />
                </div>
              </div>

              {/* Engagement Metrics - compact row with icons */}
              <div className="flex items-center gap-2 pt-1">
                <BarChart3 className="h-3.5 w-3.5 text-[#B0B0B0] flex-shrink-0" />
                <span className="text-[10px] text-[#B0B0B0] uppercase tracking-wider font-medium flex-shrink-0">Metrics</span>
                <div className="flex-1 grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <div className="relative">
                    <Heart className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#B0B0B0]" />
                    <input type="number" min="0" value={link.likes} onChange={(e) => updateLink(i, "likes", e.target.value)} placeholder="Likes" className={inputClass + " !pl-8 !py-2 !text-xs"} />
                  </div>
                  <div className="relative">
                    <MessageSquare className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#B0B0B0]" />
                    <input type="number" min="0" value={link.comments} onChange={(e) => updateLink(i, "comments", e.target.value)} placeholder="Comments" className={inputClass + " !pl-8 !py-2 !text-xs"} />
                  </div>
                  <div className="relative">
                    <Share2 className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#B0B0B0]" />
                    <input type="number" min="0" value={link.shares} onChange={(e) => updateLink(i, "shares", e.target.value)} placeholder="Shares" className={inputClass + " !pl-8 !py-2 !text-xs"} />
                  </div>
                  <div className="relative">
                    <Eye className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#B0B0B0]" />
                    <input type="number" min="0" value={link.views} onChange={(e) => updateLink(i, "views", e.target.value)} placeholder="Views" className={inputClass + " !pl-8 !py-2 !text-xs"} />
                  </div>
                  <div>
                    <input type="text" value={link.description} onChange={(e) => updateLink(i, "description", e.target.value)} placeholder="Description" className={inputClass + " !py-2 !text-xs"} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {links.length < MAX_LINKS && (
          <button
            type="button"
            onClick={addLink}
            className="flex items-center gap-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] font-medium px-4 py-3 rounded-xl border border-dashed border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[#FFFDF5] transition-all w-full justify-center bg-[#FEFCF7] group"
          >
            <div className="h-6 w-6 rounded-md bg-[#F7ECD5] flex items-center justify-center group-hover:bg-[#FFF3C4] transition-colors">
              <Plus className="h-3.5 w-3.5 text-[#7A7A7A] group-hover:text-[#B8960C]" />
            </div>
            Add Another Link
          </button>
        )}

        {/* Notes section */}
        <div className="flex items-center gap-2 pt-2">
          <MessageSquare className="h-4 w-4 text-[#B8960C]" />
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Notes</h2>
          <div className="flex-1 h-px bg-[#E8E0D0]" />
        </div>

        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-[#E8E0D0] p-5 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-shadow">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Any additional notes or observations about today's work..."
            className="w-full border border-[#E8E0D0] bg-[#FEFCF7] rounded-lg px-4 py-3 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-all duration-200 resize-none"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Submit Section */}
        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading || !!duplicateWarning || !!accountLimitWarning}
            className="flex-1 bg-[#1A1A1A] text-white py-3.5 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 group relative overflow-hidden"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Submitting...</span>
              </>
            ) : (
              <>
                <Send className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
                <span>{existing ? "Update Report" : "Submit Report"}</span>
              </>
            )}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="px-8 py-3.5 border border-[#E8E0D0] text-[#7A7A7A] rounded-full hover:bg-[#F7ECD5] hover:text-[#1A1A1A] transition-all font-medium"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
