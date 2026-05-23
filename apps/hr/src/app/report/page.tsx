"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Trash2, AlertTriangle, FileText, Link2, MessageSquare,
  BarChart3, Send, Loader2, ChevronDown, Hash, Eye, Heart, Share2,
  Clock, Zap, CheckCircle2, XCircle,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport } from "@/lib/hooks/use-reports";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LinkEntry {
  accountId: string;
  url: string;
  description: string;
  likes: string;
  comments: string;
  shares: string;
  views: string;
  mediaUrl: string;
  isScheduled: boolean;
  scheduledFor: string;
  matchStatus?: "auto" | "manual" | "unmatched";
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LINKS = 500;

const PLATFORM_DOMAINS: Record<string, string[]> = {
  instagram: ["instagram.com", "instagr.am"],
  facebook: ["facebook.com", "fb.com", "fb.watch"],
  youtube: ["youtube.com", "youtu.be"],
  twitter: ["twitter.com", "x.com", "t.co"],
  linkedin: ["linkedin.com", "lnkd.in"],
  snapchat: ["snapchat.com", "snap.com"],
};

const PLATFORM_ACCENT: Record<string, string> = {
  instagram: "border-l-pink-400",
  twitter: "border-l-sky-400",
  linkedin: "border-l-blue-600",
  facebook: "border-l-blue-500",
  youtube: "border-l-red-500",
  snapchat: "border-l-yellow-400",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyLink(): LinkEntry {
  return {
    accountId: "", url: "", description: "", likes: "", comments: "",
    shares: "", views: "", mediaUrl: "", isScheduled: false, scheduledFor: "",
  };
}

function detectPlatformFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const [slug, domains] of Object.entries(PLATFORM_DOMAINS)) {
      if (domains.some((d) => host === d || host.endsWith("." + d))) return slug;
    }
  } catch { /* invalid url */ }
  return null;
}

// max-w-full + min-w-0 are critical on mobile: without them, the select's intrinsic
// width (driven by its longest <option> text — e.g. "BollywoodChronicle (Instagram)")
// can force its parent grid/flex cell wider than the viewport, which in turn pushes
// the whole card past the right edge of the screen.
const inputClass = "w-full max-w-full min-w-0 border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-all duration-200";
const selectClass = "w-full max-w-full min-w-0 border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-all duration-200 appearance-none";

// ─── Metrics row (shared) ─────────────────────────────────────────────────────

function MetricsRow({ link, onChange }: {
  link: LinkEntry;
  onChange: (field: keyof LinkEntry, val: string) => void;
}) {
  return (
    <div className="pt-1">
      <div className="hidden sm:flex items-center gap-2 mb-1.5">
        <BarChart3 className="h-3.5 w-3.5 text-[#B0B0B0]" />
        <span className="text-[10px] text-[#B0B0B0] uppercase tracking-wider font-medium">Metrics</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {(["likes", "comments", "shares", "views"] as const).map((field, fi) => {
          const Icon = [Heart, MessageSquare, Share2, Eye][fi];
          return (
            <div key={field} className="relative min-w-0">
              <Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-[#B0B0B0]" />
              <input type="number" min="0" value={link[field]}
                onChange={(e) => onChange(field, e.target.value)}
                placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                className={inputClass + " !pl-8 !py-2 !text-xs"} />
            </div>
          );
        })}
        <input type="text" value={link.description}
          onChange={(e) => onChange("description", e.target.value)}
          placeholder="Description" className={inputClass + " !py-2 !text-xs min-w-0"} />
      </div>
    </div>
  );
}

// ─── Today's submitted links panel ───────────────────────────────────────────

function TodaySubmittedPanel({ existing, accounts }: {
  existing: any;
  accounts: any[];
}) {
  if (!existing || !existing.links || existing.links.length === 0) return null;

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const fmtTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  return (
    <div className="bg-[#FAF7F0] border border-[#E8E0D0] rounded-2xl p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-medium text-[#1A1A1A]">
            Submitted today ({existing.links.length})
          </h3>
        </div>
        <span className="text-[11px] text-[#7A7A7A]">
          Last updated {fmtTime(existing.submittedAt || existing.updatedAt || existing.createdAt)}
        </span>
      </div>
      <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {existing.links.map((l: any, i: number) => {
          const acc = accountById.get(l.accountId);
          // Link carries platformSlug from formatReport; fall back to accounts map
          const platform = (l.platformSlug || acc?.platformSlug || acc?.platform || "").toLowerCase();
          // formatReport returns accountName; accounts map uses displayName/handle
          const accountLabel = l.accountName || acc?.displayName || acc?.handle || "";
          return (
            <li
              key={l.id || i}
              className="flex items-start gap-3 bg-white border border-[#E8E0D0] rounded-lg px-3 py-2"
            >
              <span className="text-[11px] font-mono text-[#7A7A7A] mt-0.5 min-w-[1.5rem]">
                {i + 1}.
              </span>
              <div className="flex-1 min-w-0 overflow-hidden">
                {l.url ? (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[#1A1A1A] hover:text-[#B8960C] block break-all"
                  >
                    {l.url}
                  </a>
                ) : (
                  <span className="text-sm text-[#B0B0B0] italic">No URL yet</span>
                )}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-[#7A7A7A]">
                  {platform && <span className="capitalize">{platform}</span>}
                  {accountLabel && <span>· {accountLabel}</span>}
                  {l.isScheduled && (
                    <span className="inline-flex items-center gap-1 text-amber-700">
                      <Clock className="h-3 w-3" /> scheduled
                      {l.scheduledFor && ` · ${new Date(l.scheduledFor).toLocaleDateString()}`}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-[#7A7A7A]">
        These are the links currently saved for today. Edit them below — the form is pre-filled with the same list.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const router = useRouter();
  const { data: accountsData } = useAssignedAccounts();
  const { data: todayData, mutate: mutateToday } = useTodayReport();

  const accounts = (accountsData as any)?.data || [];
  const existing = (todayData as any)?.data;

  const [links, setLinks] = useState<LinkEntry[]>([emptyLink()]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  // Smart Paste state
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pasteResult, setPasteResult] = useState<{ matched: number; unmatched: number } | null>(null);
  const [defaultAccountId, setDefaultAccountId] = useState("");

  const today = new Date().toISOString().split("T")[0];
  const todayFormatted = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  useEffect(() => {
    if (existing && !prefilled) {
      setPrefilled(true);
      setNotes(existing.notes || "");
      if (existing.links?.length > 0) {
        setLinks(existing.links.map((l: any) => ({
          accountId: l.accountId || "",
          url: l.url || "",
          description: l.description || "",
          likes: l.likes?.toString() || "",
          comments: l.comments?.toString() || "",
          shares: l.shares?.toString() || "",
          views: l.views?.toString() || "",
          mediaUrl: l.mediaUrl || "",
          isScheduled: l.isScheduled || false,
          scheduledFor: l.scheduledFor ? new Date(l.scheduledFor).toISOString().slice(0, 16) : "",
          matchStatus: "manual" as const,
        })));
      }
    }
  }, [existing, prefilled]);

  // Duplicate URL detection — returns a Set of normalized URLs that appear more than once
  const duplicateUrlSet = (() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const l of links) {
      if (!l.url.trim() || l.isScheduled) continue;
      const n = l.url.trim().toLowerCase();
      if (seen.has(n)) dups.add(n);
      seen.add(n);
    }
    return dups;
  })();
  const duplicateUrls = Array.from(duplicateUrlSet);


  // Unmatched links (pasted but no account assigned)
  const unmatchedCount = links.filter(
    (l) => l.matchStatus === "unmatched" && !l.accountId
  ).length;

  function updateLink(i: number, field: keyof LinkEntry, value: string) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
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
    return ((acc?.platformSlug || acc?.platform) || "").toLowerCase();
  }

  // Smart paste: parse URLs, auto-match to accounts, append to list
  function handleSmartPaste() {
    const rawLines = pasteText.split("\n").map((l) => l.trim()).filter(Boolean);
    const urls = rawLines.filter((l) => { try { new URL(l); return true; } catch { return false; } });
    if (urls.length === 0) return;

    let matched = 0;
    let unmatched = 0;

    const newLinks: LinkEntry[] = urls.map((url) => {
      // 1. Try to auto-match by platform detected from URL
      const platform = detectPlatformFromUrl(url);
      const matchingAccounts = platform
        ? accounts.filter((a: any) => (a.platformSlug || a.platform || "").toLowerCase() === platform)
        : [];

      let accountId = "";
      let matchStatus: LinkEntry["matchStatus"] = "unmatched";

      if (matchingAccounts.length === 1) {
        accountId = matchingAccounts[0].id;
        matchStatus = "auto";
        matched++;
      } else if (defaultAccountId) {
        // 2. Fall back to the user-selected default account
        accountId = defaultAccountId;
        matchStatus = "manual";
        matched++;
      } else if (matchingAccounts.length > 1) {
        // Multiple accounts on same platform — needs manual pick
        matchStatus = "manual";
        unmatched++;
      } else {
        unmatched++;
      }

      return { ...emptyLink(), url, accountId, matchStatus };
    });

    setLinks((prev) => {
      const hasEmpty = prev.length === 1 && !prev[0].url.trim() && !prev[0].isScheduled;
      return hasEmpty ? newLinks : [...prev, ...newLinks];
    });

    setPasteResult({ matched, unmatched });
    setPasteText("");
    setTimeout(() => { setPasteResult(null); setShowPaste(false); }, 2500);
  }

  const validLinks = links.filter((l) => l.isScheduled || l.url.trim());
  const liveCount = validLinks.filter((l) => !l.isScheduled).length;
  const scheduledCount = validLinks.filter((l) => l.isScheduled).length;
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (validLinks.length === 0) { setError("At least one link is required"); return; }
    const missingAccount = validLinks.find((l) => !l.accountId);
    if (missingAccount) { setError("Please select an account for every link before submitting"); return; }
    if (duplicateUrls.length > 0) { setError("Please remove duplicate links before submitting"); return; }


    setLoading(true);
    let geo: { latitude?: number; longitude?: number } = {};
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      );
      geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch { /* optional */ }

    try {
      await apiFetch("/hr/reports", {
        method: "POST",
        body: JSON.stringify({
          date: today,
          notes,
          ...geo,
          links: validLinks.map((l) => ({
            accountId: l.accountId,
            url: l.url.trim() || null,
            platform: (accounts.find((a: any) => a.id === l.accountId) as any)?.platformSlug
              || (accounts.find((a: any) => a.id === l.accountId) as any)?.platform
              || "unknown",
            description: l.description || undefined,
            mediaUrl: l.mediaUrl || undefined,
            likes: l.likes ? parseInt(l.likes) : undefined,
            comments: l.comments ? parseInt(l.comments) : undefined,
            shares: l.shares ? parseInt(l.shares) : undefined,
            views: l.views ? parseInt(l.views) : undefined,
            isScheduled: l.isScheduled,
            scheduledFor: l.scheduledFor ? new Date(l.scheduledFor).toISOString() : undefined,
          })),
        }),
      });
      // Refresh the today-report cache so the panel shows the new links immediately
      await mutateToday();
      if (existing) {
        // Update: stay on page so user can see what they just saved in the panel
        setPrefilled(false); // allow the prefill effect to re-run with fresh data
      } else {
        // First submit: go to dashboard
        router.push("/dashboard");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 space-y-6 crx-animate-fade min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center shadow-[0_2px_8px_rgba(245,213,71,0.2)]">
              <FileText className="h-4.5 w-4.5 text-[#B8960C]" />
            </div>
            <h1 className="text-3xl font-light text-[#1A1A1A] font-serif">Daily Report</h1>
          </div>
          <p className="text-[#7A7A7A] text-sm">{todayFormatted}</p>
        </div>
        <div className="text-left sm:text-right space-y-1">
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            {liveCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-[#FFF3C4] text-[#1A1A1A] border border-[#F5D547]/20">
                <Hash className="h-3.5 w-3.5" />
                {liveCount} live
              </span>
            )}
            {scheduledCount > 0 && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-amber-50 text-amber-700 border border-amber-200">
                <Clock className="h-3.5 w-3.5" />
                {scheduledCount} scheduled
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Today's submitted links — read-only history panel */}
      <TodaySubmittedPanel existing={existing} accounts={accounts} />

      {/* Warnings */}
      {duplicateUrls.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">
            <span className="font-semibold">{duplicateUrls.length} duplicate URL{duplicateUrls.length !== 1 ? "s" : ""} detected</span> — the affected cards are highlighted in red below. Remove the duplicates before submitting.
          </p>
        </div>
      )}
      {unmatchedCount > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
          <AlertTriangle className="h-4 w-4 text-orange-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-orange-700">{unmatchedCount} pasted link{unmatchedCount !== 1 ? "s" : ""} couldn&apos;t be matched — select an account for each one below</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">

        {/* ── Smart Paste Panel ─────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-[#E8E0D0] p-4 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-shadow">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
            <button
              type="button"
              onClick={() => { setShowPaste((v) => !v); setPasteResult(null); }}
              className="text-sm font-medium text-[#1A1A1A] hover:text-[#B8960C] transition-colors flex items-center gap-2"
            >
              <div className="h-7 w-7 rounded-lg bg-[#FFF3C4] flex items-center justify-center">
                <Zap className="h-3.5 w-3.5 text-[#B8960C]" />
              </div>
              Paste &amp; Auto-Sort Links
              <ChevronDown className={`h-3.5 w-3.5 text-[#B0B0B0] transition-transform duration-200 ${showPaste ? "rotate-180" : ""}`} />
            </button>

            {accounts.length > 0 && (
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <label className="text-xs text-[#7A7A7A] shrink-0">Fallback account:</label>
                <select
                  value={defaultAccountId}
                  onChange={(e) => setDefaultAccountId(e.target.value)}
                  className="border border-[#E8E0D0] bg-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#F5D547] transition-all flex-1 sm:flex-none min-w-0"
                >
                  <option value="">None</option>
                  {accounts.map((acc: any) => (
                    <option key={acc.id} value={acc.id}>{acc.handle || acc.displayName} ({acc.platform})</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {showPaste && (
            <div className="space-y-3 mt-3 pt-3 border-t border-[#F0EAD8]" style={{ animation: "crx-slideDown 0.2s ease-out" }}>
              <p className="text-xs text-[#7A7A7A]">
                Paste all your proof links at once — one per line. We&apos;ll detect the platform from each URL and automatically assign it to your matching account.
              </p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={4}
                placeholder={"https://instagram.com/p/...\nhttps://facebook.com/...\nhttps://youtube.com/watch?v=..."}
                className={inputClass + " resize-none text-xs font-mono"}
                autoFocus
              />

              {/* Result feedback */}
              {pasteResult && (
                <div className="flex items-center gap-4 text-xs">
                  <span className="flex items-center gap-1 text-green-600">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {pasteResult.matched} auto-matched
                  </span>
                  {pasteResult.unmatched > 0 && (
                    <span className="flex items-center gap-1 text-orange-600">
                      <XCircle className="h-3.5 w-3.5" />
                      {pasteResult.unmatched} need manual account selection
                    </span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSmartPaste}
                  disabled={(() => { try { const u = pasteText.split("\n").filter((l) => { try { new URL(l.trim()); return true; } catch { return false; } }); return u.length === 0; } catch { return true; } })()}
                  className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-40 transition-all shadow-sm hover:shadow-md flex items-center gap-2"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Add &amp; Auto-Sort
                </button>
                <span className="text-xs text-[#B0B0B0]">
                  {(() => {
                    const count = pasteText.split("\n").filter((l) => { try { new URL(l.trim()); return true; } catch { return false; } }).length;
                    return count > 0 ? `${count} URL${count !== 1 ? "s" : ""} detected` : "Paste URLs above";
                  })()}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Post Links section header ─────────────────────────────────── */}
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-[#B8960C]" />
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Post Links</h2>
          <div className="flex-1 h-px bg-[#E8E0D0]" />
        </div>

        {/* ── Individual link cards ─────────────────────────────────────── */}
        {links.map((link, i) => {
          const platform = getAccountPlatform(link.accountId);
          const accentClass = PLATFORM_ACCENT[platform] || "border-l-[#E8E0D0]";
          const isUnmatched = link.matchStatus === "unmatched" && !link.accountId;
          const isDuplicate = !!link.url.trim() && duplicateUrlSet.has(link.url.trim().toLowerCase());

          return (
            <div
              key={i}
              className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-l-[3px] ${isDuplicate ? "border-red-200 border-l-red-500 bg-red-50/40" : isUnmatched ? "border-orange-200 border-l-orange-400" : "border-[#E8E0D0] " + accentClass} p-4 space-y-3 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all duration-200 max-w-full overflow-hidden`}
              style={{ animation: "crx-slideUp 0.3s ease-out" }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="h-6 w-6 rounded-md bg-[#F7ECD5] flex items-center justify-center text-xs font-semibold text-[#7A7A7A] shrink-0">{i + 1}</span>
                  <h3 className="font-medium text-[#1A1A1A] text-sm">Link #{i + 1}</h3>
                  {link.matchStatus === "auto" && !isDuplicate && (
                    <span className="text-[10px] text-green-600 font-medium flex items-center gap-0.5">
                      <CheckCircle2 className="h-3 w-3" /> auto-matched
                    </span>
                  )}
                  {isDuplicate && (
                    <span className="text-[10px] text-red-600 font-semibold flex items-center gap-0.5 bg-red-100 px-1.5 py-0.5 rounded-full">
                      <XCircle className="h-3 w-3" /> Duplicate URL
                    </span>
                  )}
                  {isUnmatched && !isDuplicate && (
                    <span className="text-[10px] text-orange-600 font-medium flex items-center gap-0.5">
                      <XCircle className="h-3 w-3" /> needs account
                    </span>
                  )}
                  {platform && !isUnmatched && !isDuplicate && (
                    <span className="text-[10px] uppercase tracking-wider text-[#B0B0B0] font-medium">{platform}</span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Scheduled toggle */}
                  <button
                    type="button"
                    onClick={() => updateLink(i, "isScheduled", String(!link.isScheduled))}
                    className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-all ${link.isScheduled ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-[#F7ECD5] border-[#E8E0D0] text-[#7A7A7A] hover:border-amber-200"}`}
                  >
                    <Clock className="h-3 w-3" />
                    {link.isScheduled ? "Scheduled" : "Scheduled?"}
                  </button>
                  {links.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLink(i)}
                      className="text-[#B0B0B0] hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {link.isScheduled && (
                <input
                  type="datetime-local"
                  value={link.scheduledFor}
                  onChange={(e) => updateLink(i, "scheduledFor", e.target.value)}
                  className="border border-amber-200 bg-amber-50 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-amber-300 transition-all w-full sm:w-auto"
                />
              )}

              <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-3">
                <div className="relative min-w-0">
                  <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Account</label>
                  <select
                    value={link.accountId}
                    onChange={(e) => {
                      updateLink(i, "accountId", e.target.value);
                      // clear unmatched flag once user picks manually
                      if (link.matchStatus === "unmatched") updateLink(i, "matchStatus", "manual");
                    }}
                    className={selectClass + (isUnmatched ? " border-orange-300 focus:ring-orange-300" : "")}
                  >
                    <option value="">Select account...</option>
                    {accounts.map((acc: any) => (
                      <option key={acc.id} value={acc.id}>{acc.handle || acc.displayName} ({acc.platform})</option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0">
                  <label className="block text-xs font-medium text-[#7A7A7A] mb-1">
                    URL {link.isScheduled ? "(optional — fill when live)" : "*"}
                  </label>
                  <input
                    type="url"
                    value={link.url}
                    onChange={(e) => {
                      updateLink(i, "url", e.target.value);
                      // Auto-select account when URL gives a clear platform match and no account picked yet
                      if (!link.accountId) {
                        const p = detectPlatformFromUrl(e.target.value);
                        if (p) {
                          const matches = accounts.filter((a: any) => (a.platformSlug || a.platform || "").toLowerCase() === p);
                          if (matches.length === 1) {
                            updateLink(i, "accountId", matches[0].id);
                            updateLink(i, "matchStatus", "auto");
                          }
                        }
                      }
                    }}
                    placeholder="https://instagram.com/p/..."
                    required={!link.isScheduled}
                    className={inputClass}
                  />
                </div>
              </div>

              <MetricsRow link={link} onChange={(f, v) => updateLink(i, f, v)} />
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

        {/* Notes */}
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

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-[#1A1A1A] text-white py-3.5 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all shadow-md hover:shadow-lg flex items-center justify-center gap-2 group relative overflow-hidden"
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /><span>Submitting...</span></>
            ) : (
              <><Send className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" /><span>{existing ? "Update Report" : "Submit Report"}</span></>
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
