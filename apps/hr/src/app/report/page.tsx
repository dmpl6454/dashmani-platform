"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  Plus, Trash2, AlertTriangle, FileText, Link2, MessageSquare,
  BarChart3, Send, Loader2, ChevronDown, Hash, Eye, Heart, Share2,
  Clock, Zap, CheckCircle2, XCircle, X,
} from "lucide-react";
import { canonicalKey } from "@dashmani/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport, useMyLinkInsights } from "@/lib/hooks/use-reports";
import { InsightBadge } from "@/components/insight-badge";

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
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[#7A7A7A]">
            Last updated {fmtTime(existing.submittedAt || existing.updatedAt || existing.createdAt)}
          </span>
          <button
            type="button"
            onClick={() => document.getElementById("post-links-form")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-500 underline underline-offset-2 transition-colors shrink-0"
          >
            Edit submitted links ↓
          </button>
        </div>
      </div>
      <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {existing.links.map((l: any, i: number) => {
          const acc = accountById.get(l.accountId);
          const platform = (l.platformSlug || acc?.platformSlug || acc?.platform || "").toLowerCase();
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
        To add, remove, or change a link — use the form below and click <span className="font-medium text-[#1A1A1A]">Update Links</span> to save.
      </p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReportPage() {
  const router = useRouter();
  const { data: accountsData } = useAssignedAccounts();
  const { data: todayData, mutate: mutateToday } = useTodayReport();
  const { data: myInsightsData, isLoading: myInsightsLoading } = useMyLinkInsights(30);

  const accounts = (accountsData as any)?.data || [];
  const existing = (todayData as any)?.data;

  // ── Draft auto-save state ──────────────────────────────────────────────────
  // "draft-pending" → user made a change, debounce timer running
  // "saving"        → PUT /hr/reports/draft in flight
  // "saved"         → last save succeeded (shows "Draft saved" indicator)
  // "idle"          → no unsaved changes (on load, or after restore)
  const [draftStatus, setDraftStatus] = useState<"idle" | "draft-pending" | "saving" | "saved">("idle");
  const [draftRestored, setDraftRestored] = useState(false); // toast flag
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether draft restore has run (once per mount)
  const draftRestoredRef = useRef(false);
  // Track whether todayData has loaded (null = no report, object = has report)
  const todayDataLoadedRef = useRef(false);

  const [links, setLinks] = useState<LinkEntry[]>([emptyLink()]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  // Per-row validation errors from API (key = row index, value = {field: message})
  const [rowErrors, setRowErrors] = useState<Record<number, Record<string, string>>>({});

  // Compact COUNT-only dedupe notice (no per-link list, no screen-blocking modal —
  // a long list became an unreadable full-screen scroll wall on mobile and alarmed
  // people). Rendered as a viewport-fixed toast via a portal to document.body (see
  // below) so it stays in view regardless of scroll.
  //   inSubmission: same link already in the form (pasted/typed twice)
  //   crossDay: already submitted on a previous day
  const [dedupeNotice, setDedupeNotice] = useState<{ inSubmission: number; crossDay: number } | null>(null);
  // Portal target only exists in the browser — gate rendering until mounted to
  // avoid an SSR/hydration mismatch (document is undefined on the server).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const dedupeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesce removals from the SAME paste (in-submission + cross-day fire close
  // together) into one notice, but start fresh for a later paste. Tracks the last
  // notice's start time so we add-to vs. reset.
  const dedupeNoticeStartedAt = useRef(0);

  // Smart Paste state
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pasteResult, setPasteResult] = useState<{ matched: number; unmatched: number } | null>(null);
  const [defaultAccountId, setDefaultAccountId] = useState("");

  // Persistent post-submit summary shown ABOVE the submit button (no auto-dismiss,
  // no portal). The paste-time dedupe toast auto-dismisses after 6s, so a heavy
  // submitter who scrolls to verify their rows sees no message by the time they
  // click Update and notice a lower saved count — which reads as "my links
  // vanished" even though the drop was correct de-duplication. This summary stays
  // put at the exact spot the user is looking at submit time, and is cleared on
  // the next edit/paste so it never lingers stale.
  const [submitSummary, setSubmitSummary] = useState<
    { saved: number; skipped: number; inSubmission: number; crossDay: number } | null
  >(null);

  // Past link URLs for cross-day duplicate detection (last 90 days, excluding
  // today). 90 matches the server's CROSS_DAY_WINDOW_DAYS in daily-report.service
  // — previously this was 60, so the server could silently drop a 61–90-day-old
  // duplicate the client never flagged at paste time (a silent server-only drop).
  // Aligning the windows means the client now flags exactly what the server drops.
  const { data: pastUrlMapData } = useSWR(
    "/hr/reports/my-link-urls?days=90",
    (key: string) => apiFetch<{ success: boolean; data: Record<string, string> }>(key).then((r) => r.data),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  // Use local date (browser IST) — not toISOString() which returns UTC and would
  // give the wrong date between 12:00 AM and 5:30 AM IST.
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; })();
  const todayFormatted = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Live refs to the latest links/notes — used both by the debounced draft
  // auto-save AND by the restore effect's pristine-guard (so an async restore
  // resolving after a paste can see the current form state). Declared before the
  // restore effect because that effect references linksRef.
  const linksRef = useRef(links);
  const notesRef = useRef(notes);
  useEffect(() => { linksRef.current = links; }, [links]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // ── Prefill + draft restore (combined, runs once todayData resolves) ──────
  // Priority:
  //   1. If a draft exists and was saved AFTER the submitted report → restore draft
  //      (employee added more links after submitting, then closed the tab)
  //   2. If a submitted report exists (no newer draft) → prefill from submitted
  //   3. If neither → start with empty form (or restore draft if one exists)
  useEffect(() => {
    if (todayData === undefined) return; // SWR still loading
    if (draftRestoredRef.current) return; // already ran
    draftRestoredRef.current = true;

    const d = new Date();
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    // Defense-in-depth: this async callback resolves AFTER mount, by which time the
    // employee may have already typed/pasted links. Never overwrite a form that
    // already holds user content — restoring a stale server/draft snapshot over
    // freshly-entered links is exactly how added links silently vanished.
    const formIsPristine = () => {
      const ls = linksRef.current;
      return ls.length <= 1 && !ls[0]?.url.trim() && !ls[0]?.isScheduled && !ls[0]?.accountId;
    };

    apiFetch<any>(`/hr/reports/draft?date=${dateKey}`)
      .then((res) => {
        const draft = res?.data;
        const hasDraft = draft && Array.isArray(draft.links) && draft.links.length > 0;
        const draftSavedAt = hasDraft ? new Date(draft.savedAt).getTime() : 0;
        const submittedAt = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;

        // Draft is newer than submitted report → restore draft (employee made changes after submitting)
        if (hasDraft && draftSavedAt > submittedAt) {
          if (formIsPristine()) {
            setLinks(draft.links);
            setNotes(draft.notes || "");
            setDraftRestored(true);
            setTimeout(() => setDraftRestored(false), 5000);
          }
          setPrefilled(true);
          return;
        }

        // No newer draft → use submitted report if it exists
        if (existing && !prefilled) {
          setPrefilled(true);
          setNotes(existing.notes || "");
          if (existing.links?.length > 0 && formIsPristine()) {
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
      })
      .catch(() => {
        // Draft fetch failed — fall back to submitted report if available
        if (existing && !prefilled) {
          setPrefilled(true);
          setNotes(existing.notes || "");
          if (existing.links?.length > 0 && formIsPristine()) {
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
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayData]);

  // ── Auto-save: debounced 3s after any links/notes change ──────────────────
  // Always runs — even when a submitted report exists — because the employee
  // may be adding more links after submitting and we must preserve that.
  const saveDraft = useCallback(async (currentLinks: LinkEntry[], currentNotes: string) => {
    const d = new Date();
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    setDraftStatus("saving");
    try {
      await apiFetch("/hr/reports/draft", {
        method: "PUT",
        body: JSON.stringify({ date: dateKey, notes: currentNotes, links: currentLinks }),
      });
      setDraftStatus("saved");
    } catch {
      setDraftStatus("idle");
    }
  }, []);

  useEffect(() => {
    // Don't auto-save before initial restore has run (avoids saving the empty default row)
    if (!draftRestoredRef.current) return;
    setDraftStatus("draft-pending");
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveDraft(linksRef.current, notesRef.current);
    }, 3000);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, notes]);

  // Push removed-link COUNTS into the compact notice. Removals from the same paste
  // (in-submission + cross-day fire within milliseconds) coalesce into one notice;
  // a later paste (> the coalesce window) starts a fresh count rather than stacking
  // onto a stale one. Auto-dismisses; no list, no backdrop.
  const pushDedupeNotice = useCallback((reason: "in-submission" | "cross-day", count: number) => {
    if (count <= 0) return;
    const now = Date.now();
    const COALESCE_MS = 1500;
    setDedupeNotice((prev) => {
      const fresh = !prev || now - dedupeNoticeStartedAt.current > COALESCE_MS;
      const base = fresh ? { inSubmission: 0, crossDay: 0 } : prev!;
      if (fresh) dedupeNoticeStartedAt.current = now;
      return {
        inSubmission: base.inSubmission + (reason === "in-submission" ? count : 0),
        crossDay: base.crossDay + (reason === "cross-day" ? count : 0),
      };
    });
    if (dedupeToastTimer.current) clearTimeout(dedupeToastTimer.current);
    dedupeToastTimer.current = setTimeout(() => setDedupeNotice(null), 6000);
  }, []);

  // ── Auto-dedupe: in-submission (keep first occurrence, remove subsequent) ──
  // Runs after every links change. Covers both Smart Paste and manual URL typing.
  const isDeduping = useRef(false);
  const dedupeLatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isDeduping.current) return;
    const seen = new Map<string, number>(); // canonicalKey → first index
    const toRemove: number[] = [];
    links.forEach((l, i) => {
      if (l.isScheduled || !l.url.trim()) return;
      const k = canonicalKey(l.url); // collapses ?igsh= variants of the same post
      if (seen.has(k)) {
        toRemove.push(i);
      } else {
        seen.set(k, i);
      }
    });
    if (toRemove.length > 0) {
      isDeduping.current = true;
      setLinks((prev) => prev.filter((_, i) => !toRemove.includes(i)));
      pushDedupeNotice("in-submission", toRemove.length);
      // The isDeduping latch clears shortly after the state settles so the effect
      // doesn't re-enter on the setLinks-triggered re-render. Own timer ref so it
      // can't clobber the notice's auto-dismiss timer.
      if (dedupeLatchTimer.current) clearTimeout(dedupeLatchTimer.current);
      dedupeLatchTimer.current = setTimeout(() => {
        isDeduping.current = false;
      }, 400);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links]);

  // ── Auto-dedupe: cross-day (links already submitted on a previous day) ──
  // Runs once the past URL map loads/reloads. Silent removal with a notice toast.
  const crossDayDeduped = useRef(false);
  useEffect(() => {
    if (!pastUrlMapData || crossDayDeduped.current) return;
    crossDayDeduped.current = true;
    const removed: { url: string; date: string }[] = [];
    setLinks((prev) => {
      const next = prev.filter((l) => {
        if (l.isScheduled || !l.url.trim()) return true;
        const k = canonicalKey(l.url); // map keys are canonical (see my-link-urls)
        if (pastUrlMapData[k]) {
          removed.push({ url: l.url, date: pastUrlMapData[k] });
          return false;
        }
        return true;
      });
      if (removed.length > 0) {
        pushDedupeNotice("cross-day", removed.length);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastUrlMapData]);

  // Re-arm cross-day dedupe when the past URL map refreshes after submit
  function rearmCrossDay() {
    crossDayDeduped.current = false;
  }

  // (No longer a passive computed set — auto-dedupe handles duplicates reactively)
  const duplicateUrlSet = new Set<string>(); // always empty; kept so row render stays unchanged
  const duplicateUrls: string[] = [];


  // Unmatched links (pasted but no account assigned)
  const unmatchedCount = links.filter(
    (l) => l.matchStatus === "unmatched" && !l.accountId
  ).length;

  function updateLink(i: number, field: keyof LinkEntry, value: string) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
    setSubmitSummary(null); // any edit invalidates the last submit's summary
    // Clear per-row errors for this row when user starts editing
    if (rowErrors[i]) {
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[i];
        return next;
      });
    }
  }

  function addLink() {
    setLinks((prev) => [...prev, emptyLink()]);
    setSubmitSummary(null);
  }

  function removeLink(i: number) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i));
    setSubmitSummary(null);
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

      if (defaultAccountId) {
        // 1. EXPLICIT user choice wins. If the employee picked a channel in the
        // dropdown, ALL pasted links go to it — this is their stated intent and
        // must override platform auto-match. (Previously auto-match for a single
        // same-platform account silently ignored this pick, mis-filing links to
        // the wrong channel for anyone with exactly one account on that platform.)
        accountId = defaultAccountId;
        matchStatus = "manual";
        matched++;
      } else if (matchingAccounts.length === 1) {
        // 2. No channel chosen → auto-match when the URL's platform maps to
        // exactly one of the employee's accounts.
        accountId = matchingAccounts[0].id;
        matchStatus = "auto";
        matched++;
      } else if (matchingAccounts.length > 1) {
        // Multiple accounts on same platform and no channel chosen — needs manual pick
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
    setSubmitSummary(null); // new paste invalidates the last submit's summary
    setTimeout(() => { setPasteResult(null); setShowPaste(false); }, 2500);

    // Re-arm cross-day dedupe so newly pasted links get checked against past submissions.
    // Without this, links pasted after the initial dedupe pass slip through unchecked.
    crossDayDeduped.current = false;
  }

  const validLinks = links.filter((l) => l.isScheduled || l.url.trim());
  const liveCount = validLinks.filter((l) => !l.isScheduled).length;
  const scheduledCount = validLinks.filter((l) => l.isScheduled).length;
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // In-flight guard: the button's disabled={loading} is cosmetic (Enter key / rapid
    // taps can still re-enter). Prevent overlapping POSTs for the same employee+day,
    // which could interleave the server's delete-and-recreate destructively.
    if (loading) return;
    setError("");
    if (validLinks.length === 0) { setError("At least one link is required"); return; }
    const missingAccount = validLinks.find((l) => !l.accountId);
    if (missingAccount) { setError("Please select an account for every link before submitting"); return; }
    if (duplicateUrls.length > 0) { setError("Please remove duplicate links before submitting"); return; }

    // Snapshot the payload BEFORE any await. The geolocation prompt below can take
    // up to 5s, during which a paste or a late draft-restore could mutate `links`.
    // Sending this frozen snapshot guarantees we POST exactly what the user saw at
    // click time — a subset can never sneak in mid-submit.
    const payloadLinks = validLinks;
    const payloadNotes = notes;

    setLoading(true);
    let geo: { latitude?: number; longitude?: number } = {};
    try {
      const pos = await new Promise<GeolocationPosition>((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      );
      geo = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch { /* optional */ }

    try {
      const res = await apiFetch<{
        data: { links: Array<{ url: string | null; isScheduled?: boolean }>; dedupe?: { inSubmission: number; crossDay: number; total: number } };
      }>("/hr/reports", {
        method: "POST",
        body: JSON.stringify({
          date: today,
          notes: payloadNotes,
          ...geo,
          links: payloadLinks.map((l) => ({
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

      // Headline count is derived from the POST RESPONSE (what was actually saved)
      // vs the snapshot we sent — counting live (non-scheduled, has-url) rows on
      // both sides. This can never disagree with the count the user sees, because
      // both come from the same saved `links` array the Today panel renders. The
      // server's reason-split (`dedupe`) is optional enrichment for the copy; if a
      // future server omits it, the headline still works. Read this BEFORE
      // mutateToday() — the revalidated /today cache carries no `dedupe`.
      const savedLinks = res?.data?.links ?? [];
      const savedLive = savedLinks.filter((l) => !l.isScheduled && l.url && String(l.url).trim()).length;
      const pastedLive = payloadLinks.filter((l) => !l.isScheduled && l.url.trim()).length;
      const skipped = Math.max(0, pastedLive - savedLive);
      const reasons = res?.data?.dedupe ?? { inSubmission: 0, crossDay: 0, total: skipped };

      // Refresh the today-report cache so the panel shows the new links immediately
      await mutateToday();
      // Re-arm cross-day dedupe so the refreshed URL map is applied on next paste
      rearmCrossDay();
      setRowErrors({});

      // Clear draft — what was just submitted is now in daily_reports.
      // Fire-and-forget — if DELETE fails the draft is stale but harmless.
      apiFetch("/hr/reports/draft", { method: "DELETE" })
        .catch(() => { /* non-critical */ });
      setDraftStatus("idle");

      // Show the persistent at-submit summary whenever the server silently dropped
      // duplicates — this is what stops "84 saved, no message" from reading as loss.
      // When it fires we also clear the transient paste toast to avoid a double
      // message, and we STAY on the page (even on a first submit) so the user
      // actually reads it. Cross-day dedupe can drop links on a first submit too,
      // so this is not exclusively a resubmit concern.
      if (skipped > 0) {
        setSubmitSummary({
          saved: savedLive,
          skipped,
          inSubmission: reasons.inSubmission,
          crossDay: reasons.crossDay,
        });
        setDedupeNotice(null);
      }

      if (existing) {
        // Update (resubmit): stay on page with the in-memory links intact (they now
        // equal what was just saved). Do NOT re-arm the restore effect here — the
        // restore effect is keyed on [todayData], and the mutateToday() above just
        // changed todayData. Re-arming it caused the restore to re-run and overwrite
        // the live form (e.g. base 181 + freshly-pasted 22) with the stale server
        // snapshot before the additions were ever saved — the "added links vanish on
        // refresh" bug. Auto-save keeps working because its guard only needs
        // draftRestoredRef.current === true, which it already is.
      } else if (skipped > 0) {
        // First submit, but dupes were dropped — stay so the user sees the summary
        // explaining the lower count instead of being whisked to the dashboard.
      } else {
        // First submit, clean: go to dashboard
        router.push("/dashboard");
      }
    } catch (err: any) {
      setError(err.message);
      // Unpack per-field details from ApiError so we can highlight individual rows
      if (err instanceof ApiError && err.details?.length) {
        const byRow: Record<number, Record<string, string>> = {};
        for (const d of err.details) {
          // Zod path "links.3.url" → row 3, field "url"
          const m = d.field.match(/^links\.(\d+)\.(\w+)$/);
          if (m) {
            const idx = Number(m[1]);
            (byRow[idx] ??= {})[m[2]] = d.message;
          }
        }
        if (Object.keys(byRow).length > 0) {
          setRowErrors(byRow);
          // Scroll to the first error row
          const firstIdx = Math.min(...Object.keys(byRow).map(Number));
          setTimeout(() => {
            document.getElementById(`link-row-${firstIdx}`)?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }, 50);
        }
      }
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
            <h1 className="text-3xl font-light text-[#1A1A1A] font-serif">Link Report</h1>
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
            {/* Draft auto-save status indicator — only shown when no submitted report */}
            {!existing && draftStatus === "saving" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-[#B0B0B0]">
                <Loader2 className="h-3 w-3 animate-spin" /> Saving…
              </span>
            )}
            {!existing && draftStatus === "saved" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                <CheckCircle2 className="h-3 w-3" /> Draft saved
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Today's submitted links — read-only history panel */}
      <TodaySubmittedPanel existing={existing} accounts={accounts} />

      {/* Auto-dedupe notice — viewport-fixed floating toast (bottom-center) so it's
          visible no matter where the user has scrolled. Removing a duplicate happens
          wherever they are in a long form; an inline banner was off-screen.
          PORTALED to document.body: the page wrapper has `crx-animate-fade` whose
          retained `transform` (animation-fill-mode: both) makes it the containing
          block for position:fixed, which pinned the toast to the bottom of the form
          instead of the viewport (had to scroll down to see it). Rendering outside
          that subtree restores true viewport-fixed behaviour.
          z-40 floats above content but below the mobile sidebar drawer (z-50). */}
      {mounted && dedupeNotice && (dedupeNotice.inSubmission > 0 || dedupeNotice.crossDay > 0) && createPortal((() => {
        const total = dedupeNotice.inSubmission + dedupeNotice.crossDay;
        return (
          <div
            className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 pointer-events-none"
            role="status"
            aria-live="polite"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="pointer-events-auto w-full max-w-sm bg-amber-50 border border-amber-200 rounded-xl shadow-lg p-3.5 flex items-start gap-2.5 crx-animate-scale">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800 flex-1 min-w-0">
                <span className="font-semibold">
                  {total} duplicate link{total !== 1 ? "s" : ""} removed
                </span>
                {" "}— your unique links are kept and safe.
                <span className="block text-xs text-amber-700/90 mt-0.5">
                  {dedupeNotice.inSubmission > 0 && (
                    <>{dedupeNotice.inSubmission} already in your list</>
                  )}
                  {dedupeNotice.inSubmission > 0 && dedupeNotice.crossDay > 0 && " · "}
                  {dedupeNotice.crossDay > 0 && (
                    <>{dedupeNotice.crossDay} already posted on an earlier day</>
                  )}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDedupeNotice(null)}
                className="text-amber-600 hover:text-amber-800 flex-shrink-0"
                aria-label="Dismiss"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })(), document.body)}

      {/* Draft restored toast */}
      {draftRestored && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
          <CheckCircle2 className="h-4 w-4 text-indigo-600 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-indigo-700">
            <span className="font-semibold">Draft restored</span> — your unsaved links have been recovered.
          </p>
        </div>
      )}

      {/* Warnings */}
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
                <label className="text-xs text-[#7A7A7A] shrink-0">Assign all to:</label>
                <select
                  value={defaultAccountId}
                  onChange={(e) => setDefaultAccountId(e.target.value)}
                  className="border border-[#E8E0D0] bg-white rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#F5D547] transition-all flex-1 sm:flex-none min-w-0"
                >
                  <option value="">None (auto-detect by platform)</option>
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
                Paste all your proof links at once — one per line. Pick a channel in <span className="font-medium text-[#1A1A1A]">&ldquo;Assign all to&rdquo;</span> to send every pasted link to that channel, or leave it on <span className="font-medium text-[#1A1A1A]">None</span> to auto-detect the platform from each URL.
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
        <div id="post-links-form" className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-[#B8960C]" />
          <h2 className="text-sm font-semibold text-[#1A1A1A]">Post Links</h2>
          <div className="flex-1 h-px bg-[#E8E0D0]" />
          {existing && (
            <span className="text-[11px] text-indigo-500 font-medium shrink-0">
              editing — trash to remove, then Update Links
            </span>
          )}
        </div>

        {/* ── Individual link cards ─────────────────────────────────────── */}
        {links.map((link, i) => {
          const platform = getAccountPlatform(link.accountId);
          const accentClass = PLATFORM_ACCENT[platform] || "border-l-[#E8E0D0]";
          const isUnmatched = link.matchStatus === "unmatched" && !link.accountId;
          const isDuplicate = !!link.url.trim() && duplicateUrlSet.has(link.url.trim().toLowerCase());
          const rowErr = rowErrors[i];
          const hasRowError = !!rowErr && Object.keys(rowErr).length > 0;

          return (
            <div
              key={i}
              id={`link-row-${i}`}
              className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.04)] border border-l-[3px] ${hasRowError ? "border-red-300 border-l-red-500 bg-red-50/30" : isDuplicate ? "border-red-200 border-l-red-500 bg-red-50/40" : isUnmatched ? "border-orange-200 border-l-orange-400" : "border-[#E8E0D0] " + accentClass} p-4 space-y-3 hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)] transition-all duration-200 max-w-full overflow-hidden`}
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
                  {hasRowError && !isDuplicate && (
                    <span className="text-[10px] text-red-600 font-semibold flex items-center gap-0.5 bg-red-100 px-1.5 py-0.5 rounded-full">
                      <AlertTriangle className="h-3 w-3" /> Fix required
                    </span>
                  )}
                  {isUnmatched && !isDuplicate && !hasRowError && (
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
                  {(links.length > 1 || !!existing) && (
                    <button
                      type="button"
                      onClick={() => removeLink(i)}
                      className="text-[#B0B0B0] hover:text-red-500 transition-colors p-1.5 rounded-lg hover:bg-red-50"
                      title="Remove this link"
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
                    className={selectClass + (isUnmatched ? " border-orange-300 focus:ring-orange-300" : rowErr?.accountId ? " border-red-400 focus:ring-red-300" : "")}
                  >
                    <option value="">Select account...</option>
                    {accounts.map((acc: any) => (
                      <option key={acc.id} value={acc.id}>{acc.handle || acc.displayName} ({acc.platform})</option>
                    ))}
                  </select>
                  {rowErr?.accountId && (
                    <p className="text-xs text-red-600 mt-1">{rowErr.accountId}</p>
                  )}
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
                    className={inputClass + (rowErr?.url ? " border-red-400 focus:ring-red-300" : "")}
                  />
                  {rowErr?.url && (
                    <p className="text-xs text-red-600 mt-1">{rowErr.url}</p>
                  )}
                </div>
              </div>

              <MetricsRow link={link} onChange={(f, v) => updateLink(i, f, v)} />
            </div>
          );
        })}

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
            <div>
              <p className="text-sm text-red-600">{error}</p>
              {Object.keys(rowErrors).length > 0 && (
                <p className="text-xs text-red-500 mt-1">
                  {Object.keys(rowErrors).length} row{Object.keys(rowErrors).length !== 1 ? "s" : ""} highlighted below — fix the marked fields and resubmit.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Persistent post-submit summary — sits directly above the button so it's
            read at the moment the saved count is noticed (unlike the paste-time
            toast, which auto-dismisses). Explains WHY the saved count is lower than
            the pasted count: the difference is duplicates, not lost links. Stays
            until the next edit/paste clears it. */}
        {submitSummary && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 flex items-start gap-2.5 crx-animate-scale">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-emerald-800">
                <span className="font-semibold">{submitSummary.saved} link{submitSummary.saved !== 1 ? "s" : ""} saved</span>
                {submitSummary.skipped > 0 && (
                  <> · {submitSummary.skipped} duplicate{submitSummary.skipped !== 1 ? "s" : ""} skipped</>
                )}
                {" "}— no links were lost.
              </p>
              {submitSummary.skipped > 0 && (submitSummary.inSubmission > 0 || submitSummary.crossDay > 0) && (
                <p className="text-xs text-emerald-700/90 mt-0.5">
                  {submitSummary.inSubmission > 0 && (
                    <>{submitSummary.inSubmission} already in your submitted list</>
                  )}
                  {submitSummary.inSubmission > 0 && submitSummary.crossDay > 0 && " · "}
                  {submitSummary.crossDay > 0 && (
                    <>{submitSummary.crossDay} already posted on an earlier day</>
                  )}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSubmitSummary(null)}
              className="text-emerald-600 hover:text-emerald-800 flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 relative bg-indigo-600 text-white py-4 rounded-2xl font-bold text-base hover:bg-indigo-500 active:bg-indigo-800 active:scale-95 active:shadow-none disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-100 shadow-[0_4px_14px_rgba(99,102,241,0.45)] hover:shadow-[0_6px_20px_rgba(99,102,241,0.55)] flex items-center justify-center gap-2.5 group overflow-hidden focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-indigo-400/50"
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin shrink-0" />
                <span>{existing ? "Updating…" : "Submitting…"}</span>
              </>
            ) : (
              <>
                <Send className="h-5 w-5 shrink-0 group-hover:translate-x-1 transition-transform duration-150" />
                <span>{existing ? "Update Links" : "Submit Links"}</span>
              </>
            )}
            {/* shimmer sweep on hover */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-500 pointer-events-none" />
          </button>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="px-8 py-4 border border-[#E8E0D0] text-[#7A7A7A] rounded-2xl hover:bg-[#F7ECD5] hover:text-[#1A1A1A] transition-all font-medium"
          >
            Cancel
          </button>
        </div>
      </form>

      {/* ─── YouTube Insights Panel ─────────────────────────────────────────────
          Sits OUTSIDE the form. Never touches Smart Paste / dedupe / validation.
          Hidden entirely when the employee has no YouTube links in the last 30 days. */}
      {!myInsightsLoading && (() => {
        const allInsights: any[] = (myInsightsData as any)?.data ?? [];
        // Show every link that has engagement metrics, across ALL supported
        // platforms (YouTube + Instagram + Facebook are all covered now).
        // Sort by reach so the strongest posts lead.
        const withMetrics = allInsights
          .filter((l: any) => l.latest)
          .sort((a: any, b: any) => {
            const reach = (x: any) => (x.latest?.views ?? 0) + (x.latest?.likes ?? 0) + (x.latest?.comments ?? 0);
            return reach(b) - reach(a);
          });
        if (withMetrics.length === 0) return null;
        return (
          <section className="mt-8 bg-white border border-[#E8E0D0] rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold text-[#1A1A1A]">Your link insights</h3>
                <p className="text-[11px] text-[#7A7A7A] mt-0.5">
                  Views, likes &amp; comments for your YouTube, Instagram and Facebook links.
                </p>
              </div>
              <span className="text-[10px] text-[#B0B0B0] shrink-0 mt-0.5">Updates every 6h</span>
            </div>
            <ul className="divide-y divide-[#F5F0E8]">
              {withMetrics.map((link: any, i: number) => (
                <li key={`${link.linkId ?? link.url}-${i}`} className="px-6 py-3 flex items-center gap-3">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-[#1A1A1A] hover:underline truncate flex-1 min-w-0"
                    title={link.url}
                  >
                    {link.url}
                  </a>
                  <InsightBadge platform={link.platform} metric={link.latest} />
                </li>
              ))}
            </ul>
          </section>
        );
      })()}
    </div>
  );
}
