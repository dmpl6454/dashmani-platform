"use client";
// Accounts — premium dark redesign ("ds"), built to the Accounts.dc.html mockup.
// UI only: same endpoints (/accounts, /accounts/:id, /accounts/:id/assign,
// /accounts/sync-followers), same handlers and the same ?tab= deep links as before.
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useAccounts, usePlatforms } from "@/lib/hooks/use-accounts";
import { useEmployees } from "@/lib/hooks/use-employees";
import { formatStatus, toTitleCase } from "@dashmani/shared";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  Globe, Search, Pencil, Trash2, X, Share2, ChevronDown, Users, LayoutGrid,
  ExternalLink, UserMinus, Check, RefreshCw, AlertCircle, Clock, Plus,
} from "lucide-react";
import { ModalPortal } from "@/components/modal-portal";

type Tab = "accounts" | "by-employee" | "platforms";

// Build a safe, correct external href for an account.
// For Snapchat: PREFER the stored profileUrl (a /t/<code> or /p/<uuid> link that resolves
// to the real profile). ⚠️ Do NOT build /add/<handle> — that path 404s ("Sorry" page) for
// our accounts (live-verified 2026-07-01). Fall back to /add/<handle> only if there is no
// usable profileUrl at all.
// For other platforms: validate https:// scheme; add it if missing.
function toHttp(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null;
  let raw = url.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/\//, "");
  try { new URL(raw); } catch { return null; }
  return raw;
}
function safeProfileHref(
  url: string | null | undefined,
  platform?: { slug?: string },
  handle?: string,
): string | null {
  if (platform?.slug === "snapchat") {
    const fromUrl = toHttp(url);
    if (fromUrl) return fromUrl;
    const h = (handle ?? "").replace(/^@/, "").split("?")[0].trim();
    if (h) return `https://www.snapchat.com/add/${encodeURIComponent(h)}`;
    return null;
  }
  return toHttp(url);
}

/* ── Design tokens from the mockup ── */
const PLATFORM_STYLE: Record<string, { abbr: string; color: string; sync: string }> = {
  instagram: { abbr: "IG", color: "#EC42B7", sync: "Auto-sync" },
  facebook:  { abbr: "FB", color: "#238BFF", sync: "Auto-sync" },
  youtube:   { abbr: "YT", color: "#FF5A5F", sync: "Auto-sync" },
  snapchat:  { abbr: "SC", color: "#E9D23A", sync: "Auto-sync" },
  x:         { abbr: "X",  color: "#A7B3C2", sync: "Auto-sync" },
  twitter:   { abbr: "X",  color: "#A7B3C2", sync: "Auto-sync" },
};
function platStyle(p?: { slug?: string; name?: string }) {
  const s = PLATFORM_STYLE[(p?.slug ?? "").toLowerCase()];
  if (s) return s;
  return { abbr: (p?.name ?? "?").slice(0, 2).toUpperCase(), color: "#A7B3C2", sync: "Manual entry" };
}
const STATUS: Record<string, { label: string; color: string }> = {
  ACTIVE:   { label: "Active",   color: "#00D7A0" },
  PAUSED:   { label: "Paused",   color: "#FBBF24" },
  ARCHIVED: { label: "Archived", color: "#738395" },
};
const AV_BG = ["#10222E", "#0E2A22", "#1B1630", "#2A2410", "#2A1116"];
const AV_FG = ["#238BFF", "#34D399", "#9B7EDE", "#E9BD62", "#FB7185"];
const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const avatar = (name: string) => { const h = hash(name || "?"); return { bg: AV_BG[h % 5], fg: AV_FG[h % 5] }; };

function fmtK(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 999_500) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}
const DAY_MS = 86_400_000;
function syncAge(iso?: string | null): { label: string; stale: boolean; never: boolean } {
  if (!iso) return { label: "Never", stale: false, never: true };
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000), hrs = Math.floor(mins / 60), days = Math.floor(hrs / 24);
  const label = days > 0 ? (days === 1 ? "Yesterday" : `${days}d ago`) : hrs > 0 ? `${hrs}h ago` : mins > 1 ? `${mins}m ago` : "Just now";
  return { label, stale: diff > 5 * DAY_MS, never: false };
}
const fmtHandle = (h?: string) => (h ? (h.startsWith("@") ? h : h) : "");

const GRID = "grid items-center [grid-template-columns:minmax(200px,1.3fr)_minmax(92px,1fr)_minmax(80px,.9fr)_minmax(130px,1.1fr)_minmax(76px,1fr)_minmax(88px,.9fr)_minmax(84px,.9fr)_minmax(92px,1fr)] gap-3.5";
const inputCls = "w-full h-[38px] px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[12.5px] placeholder:text-ds-t4 outline-none transition-colors focus:border-ds-gold [color-scheme:dark]";
const labelCls = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const ghostBtn = "h-9 px-3.5 rounded-[6px] border border-ds-line2 bg-transparent text-ds-t2 text-[12px] font-semibold transition-colors hover:border-ds-line4 hover:text-ds-text disabled:opacity-50";
const goldBtn = "h-9 px-[18px] rounded-[6px] bg-ds-gold text-ds-bg text-[12px] font-bold inline-flex items-center gap-1.5 transition-colors hover:bg-ds-gold2 disabled:opacity-50";

/* ── Inline create/edit slide panel ── */
function AccountPanel({
  account,
  platforms,
  onClose,
  onSaved,
}: {
  account?: any;
  platforms: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!account;
  const [form, setForm] = useState({
    handle:      account?.handle      ?? "",
    displayName: account?.displayName ?? "",
    platformId:  account?.platform?.id ?? "",
    clientName:  account?.clientName  ?? "",
    profileUrl:  account?.profileUrl  ?? "",
    status:      account?.status      ?? "ACTIVE",
  });
  const [error,   setError]   = useState<string | null>(null);
  const [saving,  setSaving]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
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
      onSaved();
    } catch (err: any) {
      setError(err?.message || "Save failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-[rgba(2,6,10,.65)]" onClick={onClose}>
      <div className="flex-1" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "Edit Account" : "Add Social Account"}
        className="w-full max-w-[420px] h-full bg-ds-card border-l border-ds-line2 flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between h-[57px] px-[22px] border-b border-ds-line shrink-0">
          <span className="text-[14px] font-semibold text-ds-text">{isEdit ? "Edit Account" : "Add Social Account"}</span>
          <button onClick={onClose} aria-label="Close" className="text-ds-t3 hover:text-ds-text transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-[22px] flex flex-col gap-4">
            {!isEdit && (
              <label className={labelCls}>
                Platform
                <span className="relative">
                  <select
                    value={form.platformId}
                    onChange={(e) => setForm({ ...form, platformId: e.target.value })}
                    required
                    className={`${inputCls} appearance-none pr-8 tracking-normal normal-case font-normal`}
                  >
                    <option value="">Select platform…</option>
                    {platforms.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
                </span>
              </label>
            )}

            {(["handle", "displayName", "clientName", "profileUrl"] as const).map((field) => (
              <label key={field} className={labelCls}>
                {field === "handle"      ? "Handle"
                : field === "displayName" ? "Display Name"
                : field === "clientName"  ? "Client Name (optional)"
                : "Profile URL (optional)"}
                <input
                  type={field === "profileUrl" ? "url" : "text"}
                  value={form[field]}
                  onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                  required={field === "handle" || field === "displayName"}
                  placeholder={
                    field === "handle"      ? "@username"
                    : field === "displayName" ? "Display name"
                    : field === "clientName"  ? "Client / brand name"
                    : "https://..."
                  }
                  className={`${inputCls} tracking-normal normal-case font-normal`}
                />
              </label>
            ))}

            {isEdit && (
              <label className={labelCls}>
                Status
                <span className="relative">
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className={`${inputCls} appearance-none pr-8 tracking-normal normal-case font-normal`}
                  >
                    {["ACTIVE", "PAUSED", "ARCHIVED"].map((s) => (
                      <option key={s} value={s}>{formatStatus(s)}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
                </span>
              </label>
            )}

            {error && <p className="text-[11.5px] text-ds-redsoft">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 px-[22px] py-4 border-t border-ds-line shrink-0">
            <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
            <button type="submit" disabled={saving} className={goldBtn}>
              <Check className="h-3.5 w-3.5" />
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Assign modal ── */
function AssignModal({
  accounts,
  preselectedEmployeeId,
  preselectedAccountId,
  employees,
  onClose,
  onDone,
}: {
  accounts: any[];
  preselectedEmployeeId?: string;
  preselectedAccountId?: string;
  employees: any[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [selectedEmployee, setSelectedEmployee] = useState(preselectedEmployeeId ?? "");
  const [selectedAccount,  setSelectedAccount]  = useState(preselectedAccountId ?? "");
  const [empSearch, setEmpSearch] = useState("");
  const [empOpen, setEmpOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone]   = useState<{ name: string; handle: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignedAccountIds = new Set<string>(
    accounts
      .filter((a: any) => a.assignments?.some((asn: any) => !asn.unassignedAt && asn.employee?.id === selectedEmployee))
      .map((a: any) => a.id)
  );

  const selectedAccountData = accounts.find((a: any) => a.id === selectedAccount);
  const selectedEmployeeName = employees.find((e: any) => e.id === selectedEmployee)?.name ?? "";

  const filteredEmployees = empSearch.trim()
    ? employees.filter((e: any) => {
        const q = empSearch.trim().toLowerCase();
        return (
          (e.name || "").toLowerCase().includes(q) ||
          (e.email || "").toLowerCase().includes(q) ||
          (e.designation || "").toLowerCase().includes(q)
        );
      })
    : employees;

  async function handleAssign() {
    if (!selectedEmployee || !selectedAccount) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/accounts/${selectedAccount}/assign`, {
        method: "POST",
        body: JSON.stringify({ employeeId: selectedEmployee }),
      });
      setDone({ name: selectedEmployeeName, handle: selectedAccountData?.handle ?? selectedAccount });
      onDone();
    } catch (err: any) {
      setError(err?.message || "Assignment failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const shell = "w-full max-w-[400px] rounded-[10px] border border-ds-line2 bg-ds-card p-[22px] shadow-[0_20px_50px_rgba(0,0,0,.6)]";

  if (done) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.7)] p-4">
      <div role="dialog" aria-modal="true" aria-label="Assigned" className={`${shell} text-center`}>
        <span className="mx-auto mb-3.5 h-12 w-12 rounded-[10px] grid place-items-center bg-ds-teal/[.14] text-ds-teal">
          <Check className="h-6 w-6" />
        </span>
        <p className="text-[15px] font-semibold text-ds-text">Assigned!</p>
        <p className="text-[12px] text-ds-t2 mt-1.5">
          <span className="font-semibold text-ds-text">{done.name}</span> → <span className="font-semibold text-ds-text">@{done.handle.replace(/^@/, "")}</span>
        </p>
        <div className="flex items-center justify-center gap-2 mt-5">
          <button onClick={() => { setDone(null); setSelectedAccount(""); }} className={ghostBtn}>Assign another</button>
          <button onClick={onClose} className={goldBtn}>Done</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.7)] p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Assign Account" className={shell} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[14px] font-semibold text-ds-text">Assign Account</p>
            <p className="text-[11px] text-ds-t3 mt-1">
              {selectedAccountData && !selectedEmployee
                ? `Give an employee access to ${selectedAccountData.displayName || selectedAccountData.handle}.`
                : "Pick an employee, then the account to give them."}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-ds-t3 hover:text-ds-text transition-colors"><X className="h-4 w-4" /></button>
        </div>

        <label className={`${labelCls} mt-[18px]`}>
          <span>Employee <span className="normal-case tracking-normal font-normal text-ds-t4">({employees.length} available)</span></span>
          <span className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
            <input
              type="text"
              value={empOpen ? empSearch : (selectedEmployeeName || empSearch)}
              onChange={(e) => { setEmpSearch(e.target.value); setEmpOpen(true); if (selectedEmployee) setSelectedEmployee(""); }}
              onFocus={() => { setEmpOpen(true); setEmpSearch(""); }}
              onBlur={() => setTimeout(() => setEmpOpen(false), 150)}
              placeholder="Type a name to search…"
              className={`${inputCls} pl-9 pr-8 tracking-normal normal-case font-normal`}
              autoComplete="off"
            />
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
            {empOpen && (
              <span className="absolute z-10 left-0 right-0 top-[42px] block max-h-60 overflow-y-auto rounded-[6px] border border-ds-line2 bg-ds-inset shadow-[0_12px_30px_rgba(0,0,0,.5)] tracking-normal normal-case font-normal">
                {filteredEmployees.length === 0 ? (
                  <span className="block px-3 py-2.5 text-[12px] text-ds-t3">No employees match &quot;{empSearch}&quot;</span>
                ) : (
                  filteredEmployees.map((e: any) => (
                    <button
                      key={e.id}
                      type="button"
                      onMouseDown={(ev) => { ev.preventDefault(); setSelectedEmployee(e.id); setSelectedAccount(""); setEmpSearch(""); setEmpOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-[12px] flex items-center justify-between gap-2 transition-colors hover:bg-ds-hover ${selectedEmployee === e.id ? "bg-ds-gold/[.12]" : ""}`}
                    >
                      <span className="text-ds-text truncate">{e.name}</span>
                      {e.designation && <span className="text-[11px] text-ds-t3 shrink-0">{e.designation}</span>}
                    </button>
                  ))
                )}
              </span>
            )}
          </span>
        </label>

        {selectedEmployee && (
          <label className={`${labelCls} mt-3.5`}>
            Social Account
            <span className="relative">
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className={`${inputCls} appearance-none pr-8 tracking-normal normal-case font-normal`}
              >
                <option value="">Select an account</option>
                {accounts.map((a: any) => {
                  const already = assignedAccountIds.has(a.id);
                  return (
                    <option key={a.id} value={a.id} disabled={already}>
                      {a.platform?.name ? `[${a.platform.name}] ` : ""}{a.handle}{a.displayName ? ` — ${a.displayName}` : ""}{already ? " (already assigned)" : ""}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
            </span>
            {selectedAccountData && (
              <span className="text-[11px] text-ds-t3 tracking-normal normal-case font-normal">
                {selectedAccountData.platform?.name} · @{String(selectedAccountData.handle).replace(/^@/, "")}
                {selectedAccountData.followerCount ? ` · ${selectedAccountData.followerCount.toLocaleString()} followers` : ""}
                {selectedAccountData.clientName ? ` · ${selectedAccountData.clientName}` : ""}
              </span>
            )}
          </label>
        )}

        {error && <p className="mt-3 text-[11.5px] text-ds-redsoft">{error}</p>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className={`${ghostBtn} h-[34px]`}>Cancel</button>
          <button
            onClick={handleAssign}
            disabled={!selectedEmployee || !selectedAccount || submitting}
            className={`${goldBtn} h-[34px] px-4`}
          >
            {submitting ? "Assigning…" : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Manual follower count (replaces the browser's window.prompt) ── */
/** Same parsing as before: digits, commas, or K / M shorthand (14M, 553K, 1200000). */
function parseFollowerInput(raw: string): number | string {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed) return "Enter a number.";
  const m = trimmed.match(/^([\d.,]+)\s*([KM])?$/);
  if (!m) return "Invalid number. Use digits only or shorthand like 14M, 553K.";
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (m[2] === "K") n *= 1000;
  if (m[2] === "M") n *= 1000000;
  if (isNaN(n) || n < 0) return "Invalid number.";
  return Math.round(n);
}

function FollowerCountModal({ target, onCancel, onSave }: {
  target: { id: string; name: string; value: number | null | undefined };
  onCancel: () => void;
  onSave: (count: number) => Promise<string | null>;
}) {
  const [value, setValue] = useState(target.value ? String(target.value) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFollowerInput(value);
    if (typeof parsed === "string") { setError(parsed); return; }
    setSaving(true); setError(null);
    const err = await onSave(parsed);
    setSaving(false);
    if (err) setError(err);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.7)] p-4" onClick={() => !saving && onCancel()}>
      <form role="dialog" aria-modal="true" aria-label="Edit follower count" onSubmit={submit} className="w-full max-w-[400px] rounded-[10px] border border-ds-line2 bg-ds-card p-[22px] shadow-[0_20px_50px_rgba(0,0,0,.6)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ds-text">Edit follower count</p>
            <p className="text-[12px] text-ds-t2 mt-1 truncate">{target.name}</p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving} aria-label="Close" className="text-ds-t3 hover:text-ds-text transition-colors"><X className="h-4 w-4" /></button>
        </div>
        <label className="block mt-4">
          <span className="text-[10.5px] font-semibold tracking-[.12em] uppercase text-ds-t3">Followers</span>
          <input
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            placeholder="e.g. 14M, 553K or 1200000"
            aria-invalid={!!error}
            className="mt-2 w-full h-10 px-3 rounded-[8px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-ds-gold"
          />
        </label>
        <p className="text-[11.5px] text-ds-t3 mt-2">Digits only, or K / M shorthand.</p>
        {error && <p role="alert" className="text-[12px] text-ds-redsoft mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onCancel} disabled={saving} className={`${ghostBtn} h-[34px]`}>Cancel</button>
          <button type="submit" disabled={saving} className="h-[34px] px-4 rounded-[6px] bg-ds-gold text-[#060D14] text-[12px] font-bold transition-colors hover:bg-[#F4D58C] disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── Delete confirm modal ── */
function DeleteModal({ target, onCancel, onConfirm, deleting }: {
  target: any; onCancel: () => void; onConfirm: () => void; deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.7)] p-4" onClick={() => !deleting && onCancel()}>
      <div role="dialog" aria-modal="true" aria-label="Delete account" className="w-full max-w-[400px] rounded-[10px] border border-ds-line2 bg-ds-card p-[22px] shadow-[0_20px_50px_rgba(0,0,0,.6)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3.5">
          <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0 bg-ds-red/[.14] text-ds-redsoft">
            <Trash2 className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ds-text">Delete account?</p>
            <p className="text-[12px] text-ds-t2 mt-1.5 leading-relaxed">
              Permanently deletes <strong className="text-ds-text">{target.displayName}</strong> ({target.handle}). If it has tasks, posts, or report links, archive it instead.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} disabled={deleting} className={`${ghostBtn} h-[34px]`}>Cancel</button>
          <button onClick={onConfirm} disabled={deleting} className="h-[34px] px-4 rounded-[6px] bg-ds-red text-white text-[12px] font-bold transition-colors hover:bg-ds-red/90 disabled:opacity-50">
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Small pieces ── */
function PlatformTile({ platform, size = 34 }: { platform?: any; size?: number }) {
  const s = platStyle(platform);
  return (
    <span
      className="grid place-items-center shrink-0 font-extrabold border"
      style={{
        width: size, height: size, borderRadius: size >= 34 ? 9 : 6,
        background: rgba(s.color, 0.12), borderColor: rgba(s.color, 0.3), color: s.color,
        fontSize: size >= 34 ? 10 : 8.5,
      }}
    >
      {s.abbr}
    </span>
  );
}

/* ══════════════════════════════ MAIN PAGE ══════════════════════════════ */
function AccountsPageInner() {
  usePageTitle("Accounts");
  const searchParams = useSearchParams();
  // Tab from query param: ?tab=by-employee or ?tab=platforms or ?tab=accounts
  const initialTab = (searchParams.get("tab") as Tab) ?? "accounts";
  const [tab, setTab] = useState<Tab>(
    ["accounts", "by-employee", "platforms"].includes(initialTab) ? initialTab : "accounts"
  );

  const [search, setSearch]               = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");

  const { data, isLoading, mutate }       = useAccounts({ search, platformId: platformFilter });
  // The unfiltered list feeds the KPIs, tab counts, By Employee and Platforms views, so
  // they describe the whole estate rather than whatever the table search narrowed to.
  const { data: allData, mutate: mutateAll } = useAccounts({});
  const { data: platformData }            = usePlatforms();
  const { data: employeeData }            = useEmployees({ status: "ACTIVE", limit: 500 });
  const accounts  = (data as any)?.data ?? [];
  const allAccounts: any[] = (allData as any)?.data ?? [];
  // `has_more` is true only if the server had more rows than the 500 ceiling.
  // We surface it so the list can never silently hide accounts again.
  const accountsTruncated = (data as any)?.meta?.has_more === true;
  const platforms = (platformData as any)?.data ?? [];
  const employees = ((employeeData as any)?.data ?? []).slice().sort((a: any, b: any) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );

  function refresh() { mutate(); mutateAll(); }

  // Panels / modals
  const [createOpen, setCreateOpen]         = useState(false);
  const [editTarget, setEditTarget]         = useState<any | null>(null);
  const [deleteTarget, setDeleteTarget]     = useState<any | null>(null);
  const [deleting, setDeleting]             = useState(false);
  const [syncing, setSyncing]               = useState(false);
  const [syncProgress, setSyncProgress]     = useState<{ processed: number; total: number; updated: number; failed: number; skipped: number } | null>(null);
  const [syncToast, setSyncToast]           = useState<string | null>(null);

  async function handleSyncFollowers() {
    setSyncing(true);
    setSyncProgress({ processed: 0, total: 0, updated: 0, failed: 0, skipped: 0 });
    setSyncToast("Sync started — Instagram, YouTube and Facebook will be refreshed (this can take a few minutes).");
    try {
      await apiFetch("/accounts/sync-followers", { method: "POST" });
      // Poll status every 3s until idle, then refresh the table
      const poll = async () => {
        try {
          const res = await apiFetch<any>("/accounts/sync-followers/status");
          const data = res.data;
          setSyncProgress({
            processed: data.processed ?? 0,
            total: data.total ?? 0,
            updated: data.updated ?? 0,
            failed: data.failed ?? 0,
            skipped: data.skipped ?? 0,
          });
          if (data.state === "running") {
            setTimeout(poll, 3000);
          } else {
            setSyncing(false);
            refresh();
            setSyncToast(
              data.total > 0
                ? `Sync complete — ${data.updated} updated, ${data.failed} failed, ${data.skipped} skipped (manual platforms).`
                : "Sync complete — no accounts found to sync."
            );
            setTimeout(() => { setSyncToast(null); setSyncProgress(null); }, 8000);
          }
        } catch {
          setSyncing(false);
          setSyncToast("Sync status check failed. The job may still be running in the background.");
          setTimeout(() => setSyncToast(null), 6000);
        }
      };
      setTimeout(poll, 2000);
    } catch (err: any) {
      setSyncing(false);
      setSyncToast(`Sync failed: ${err.message}`);
      setTimeout(() => setSyncToast(null), 6000);
    }
  }

  const [followerEdit, setFollowerEdit] = useState<{ id: string; name: string; value: number | null | undefined } | null>(null);
  function handleManualFollowerEdit(accountId: string, currentValue: number | null | undefined, name = "") {
    setFollowerEdit({ id: accountId, name, value: currentValue });
  }
  // Same request as before (PUT /accounts/:id { followerCount }); returns an error message or null.
  async function saveFollowerCount(accountId: string, count: number): Promise<string | null> {
    try {
      await apiFetch(`/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({ followerCount: count }),
      });
      setFollowerEdit(null);
      refresh();
      return null;
    } catch (err: any) {
      return err?.message || "Failed to update follower count";
    }
  }
  const [assignOpen, setAssignOpen]         = useState(false);
  const [assignEmployeeId, setAssignEmployeeId] = useState<string | undefined>();
  const [assignAccountId, setAssignAccountId]   = useState<string | undefined>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (followerEdit) setFollowerEdit(null);
      else if (deleteTarget) { if (!deleting) setDeleteTarget(null); }
      else if (assignOpen) { setAssignOpen(false); setAssignEmployeeId(undefined); setAssignAccountId(undefined); }
      else if (createOpen || editTarget) { setCreateOpen(false); setEditTarget(null); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [followerEdit, deleteTarget, deleting, assignOpen, createOpen, editTarget]);

  // Open assign with preselected employee or account
  function openAssign(opts?: { employeeId?: string; accountId?: string }) {
    setAssignEmployeeId(opts?.employeeId);
    setAssignAccountId(opts?.accountId);
    setAssignOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/accounts/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      refresh();
    } catch (err: any) {
      alert(err?.message || "Failed to delete account");
    } finally {
      setDeleting(false);
    }
  }

  async function handleUnassign(accountId: string, employeeId: string) {
    try {
      await apiFetch(`/accounts/${accountId}/assign/${employeeId}`, { method: "DELETE" });
      refresh();
    } catch (err: any) {
      alert(err?.message || "Failed to unassign");
    }
  }

  /* ── Derived figures (whole estate) ── */
  const kpiReady = !!allData;
  const activeCount = allAccounts.filter((a) => a.status === "ACTIVE").length;
  const totalFollowers = allAccounts.reduce((s, a) => s + (a.followerCount ?? 0), 0);
  const unassignedCount = allAccounts.filter((a) => !(a.assignments?.length > 0)).length;
  const staleCount = allAccounts.filter((a) => a.status !== "ARCHIVED" && syncAge(a.lastSyncedAt).stale).length;
  const platformCount = new Set(allAccounts.map((a) => a.platform?.id).filter(Boolean)).size;

  const kpis = [
    { label: "Total Accounts",  value: allAccounts.length,      color: "#238BFF", icon: Globe,       note: `${activeCount} active` },
    { label: "Total Followers", value: fmtK(totalFollowers),    color: "#E9BD62", icon: Users,       note: "across all channels" },
    { label: "Unassigned",      value: unassignedCount,         color: "#FB7185", icon: AlertCircle, note: "need an owner" },
    { label: "Stale Sync",      value: staleCount,              color: "#FBBF24", icon: Clock,       note: "older than 5 days" },
  ];

  const tabs: { id: Tab; label: string; icon: any; count: number | null }[] = [
    { id: "accounts",    label: "All Accounts", icon: Globe,      count: kpiReady ? allAccounts.length : null },
    { id: "by-employee", label: "By Employee",  icon: Users,      count: employeeData ? employees.length : null },
    { id: "platforms",   label: "Platforms",    icon: LayoutGrid, count: platformData ? platforms.length : null },
  ];

  const syncPct = syncProgress && syncProgress.total > 0 ? Math.min(100, Math.round((syncProgress.processed / syncProgress.total) * 100)) : syncing ? 4 : 100;

  const employeeQuery = employeeSearch.trim().toLowerCase();
  const visibleEmployees = employees.filter((e: any) => !employeeQuery || e.name?.toLowerCase().includes(employeeQuery));

  return (
    <div className="pb-6">
      {/* Modals — portalled to document.body so fixed positioning isn't affected by any transformed ancestor.
          The portal lands outside the dark shell, so re-apply its typography scope (display:contents keeps
          inherited font/colour without painting a box). */}
      <ModalPortal>
        <div className="ds-root contents">
          {(createOpen || editTarget) && (
            <AccountPanel
              account={editTarget ?? undefined}
              platforms={platforms}
              onClose={() => { setCreateOpen(false); setEditTarget(null); }}
              onSaved={() => { setCreateOpen(false); setEditTarget(null); refresh(); }}
            />
          )}
          {assignOpen && (
            <AssignModal
              accounts={allAccounts.length ? allAccounts : accounts}
              employees={employees}
              preselectedEmployeeId={assignEmployeeId}
              preselectedAccountId={assignAccountId}
              onClose={() => { setAssignOpen(false); setAssignEmployeeId(undefined); setAssignAccountId(undefined); }}
              onDone={() => refresh()}
            />
          )}
          {followerEdit && (
            <FollowerCountModal
              key={followerEdit.id}
              target={followerEdit}
              onCancel={() => setFollowerEdit(null)}
              onSave={(n) => saveFollowerCount(followerEdit.id, n)}
            />
          )}
          {deleteTarget && (
            <DeleteModal
              target={deleteTarget}
              onCancel={() => setDeleteTarget(null)}
              onConfirm={handleDelete}
              deleting={deleting}
            />
          )}
        </div>
      </ModalPortal>

      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Social Media</p>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Accounts</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {kpiReady ? `${allAccounts.length} connected channels across ${platformCount} platform${platformCount === 1 ? "" : "s"}` : "Loading…"}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleSyncFollowers}
            disabled={syncing}
            title="Re-fetch follower counts for Instagram, YouTube and Facebook accounts (other platforms must be entered manually)"
            className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-blue/50 hover:text-[#6EB2FF] disabled:opacity-60"
          >
            <RefreshCw className={`h-[13px] w-[13px] ${syncing ? "animate-spin" : ""}`} strokeWidth={1.8} />
            {syncing
              ? syncProgress && syncProgress.total > 0
                ? `Syncing ${syncProgress.processed}/${syncProgress.total}…`
                : "Syncing…"
              : "Sync Followers"}
          </button>
          <button
            onClick={() => openAssign({})}
            className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-teal/50 hover:text-ds-teal"
          >
            <Share2 className="h-[13px] w-[13px]" strokeWidth={1.8} /> Assign
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22]"
          >
            + Add Account
          </button>
        </div>
      </section>

      {/* Sync status banner */}
      {syncToast && (
        <section className="flex items-center gap-3.5 mb-3.5 px-4 py-3 rounded-[8px] border border-ds-blue/35 bg-ds-blue/[.07]" role="status" aria-live="polite">
          <RefreshCw className={`h-4 w-4 text-[#6EB2FF] shrink-0 ${syncing ? "animate-spin" : ""}`} strokeWidth={1.8} />
          <div className="flex-1 min-w-0">
            <p className="text-[12.5px] font-semibold text-ds-text">{syncToast}</p>
            {syncProgress && (
              <div className="flex items-center gap-2.5 mt-2 flex-wrap">
                <div className="flex-1 min-w-[120px] max-w-[360px] h-1 rounded-[2px] bg-[#132430] overflow-hidden">
                  <div className="h-full bg-ds-blue transition-[width] duration-300" style={{ width: `${syncPct}%` }} />
                </div>
                {syncProgress.total > 0 && (
                  <span className="text-[10.5px] text-ds-t2 whitespace-nowrap">
                    {syncProgress.processed} of {syncProgress.total} processed · {syncProgress.updated} updated · {syncProgress.failed} failed · {syncProgress.skipped} skipped
                  </span>
                )}
              </div>
            )}
          </div>
          <button onClick={() => setSyncToast(null)} title="Dismiss" aria-label="Dismiss" className="text-ds-t3 hover:text-ds-text transition-colors">
            <X className="h-4 w-4" />
          </button>
        </section>
      )}

      {/* KPI cards */}
      <section className="grid gap-2.5 sm:gap-3 grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.label} className="flex flex-col min-[480px]:flex-row gap-2.5 min-[480px]:gap-3 min-[480px]:items-center px-3.5 py-4 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden min-w-0">
              <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(k.color, 0.13), color: k.color }}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-ds-t5 truncate">{k.label}</span>
                <span className="block text-[26px] font-semibold tracking-[-.02em] leading-none mt-1.5 text-ds-text">{kpiReady ? k.value : "—"}</span>
                <span className="block text-[10.5px] text-ds-t3 mt-1.5 truncate">{k.note}</span>
              </span>
            </div>
          );
        })}
      </section>

      {/* Tabs */}
      <section className="flex items-center gap-1 mt-5 shadow-[inset_0_-1px_0_#182C39] overflow-x-auto [scrollbar-width:none]" role="tablist">
        {tabs.map(({ id, label, icon: Icon, count }) => {
          const sel = tab === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={sel}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-[7px] h-10 px-4 text-[12.5px] font-semibold whitespace-nowrap transition-colors ${sel ? "text-ds-text" : "text-ds-t2 hover:text-ds-text"}`}
              style={{ boxShadow: `inset 0 -2px 0 ${sel ? "#E9BD62" : "transparent"}` }}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
              {label}
              <span className="h-[18px] min-w-[20px] px-1.5 rounded-[9px] bg-ds-hover text-ds-t2 text-[10px] font-bold grid place-items-center">{count ?? "—"}</span>
            </button>
          );
        })}
      </section>

      {/* ── TAB: All Accounts ── */}
      {tab === "accounts" && (
        <>
          <section className="flex items-center gap-2.5 flex-wrap mt-3.5">
            <label className="flex items-center gap-2 h-[34px] px-3 rounded-[17px] bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_300px] min-w-[200px] focus-within:border-ds-gold">
              <Search className="h-[13px] w-[13px] shrink-0" strokeWidth={1.8} />
              <input
                type="text"
                placeholder="Search accounts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search accounts"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[12px] placeholder:text-ds-t3"
              />
              {search && (
                <button type="button" onClick={() => setSearch("")} aria-label="Clear search" className="text-ds-t3 hover:text-ds-text"><X className="h-3.5 w-3.5" /></button>
              )}
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Platform">
              {[{ id: "", name: "All Platforms", color: "#E9BD62" }, ...platforms.map((p: any) => ({ id: p.id, name: p.name, color: platStyle(p).color }))].map((p) => {
                const sel = platformFilter === p.id;
                return (
                  <button
                    key={p.id || "all"}
                    type="button"
                    aria-pressed={sel}
                    onClick={() => setPlatformFilter(p.id)}
                    className={`inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-[13px] border text-[11px] font-semibold whitespace-nowrap transition-colors ${sel ? "bg-ds-gold/[.14] border-ds-gold/55 text-ds-text" : "bg-ds-inset border-ds-line2 text-ds-t2 hover:text-ds-text hover:border-ds-line4"}`}
                  >
                    <i className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
                    {p.name}
                  </button>
                );
              })}
            </div>
            {!isLoading && (
              <span className="ml-auto text-[11px] text-ds-t3">
                {search || platformFilter
                  ? `${accounts.length} result${accounts.length === 1 ? "" : "s"}`
                  : `Showing ${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
                {accountsTruncated && (
                  <span className="ml-2 text-ds-gold font-semibold">· showing the first 500 — narrow your search to see the rest</span>
                )}
              </span>
            )}
          </section>

          <section className="mt-3 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[980px]" role="table" aria-label="Social accounts">
                <div role="row" className={`${GRID} h-10 px-6 text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-b border-ds-line bg-[#0A1620]`}>
                  <span role="columnheader">Account</span>
                  <span role="columnheader" className="text-center">Platform</span>
                  <span role="columnheader" className="text-center">Client</span>
                  <span role="columnheader" className="text-center">Assigned To</span>
                  <span role="columnheader" className="text-center">Followers</span>
                  <span role="columnheader" className="text-center">Last Synced</span>
                  <span role="columnheader" className="text-center">Status</span>
                  <span role="columnheader" className="text-center">Actions</span>
                </div>

                {isLoading ? (
                  <div className="px-5 py-12 text-center text-[12.5px] text-ds-t3">Loading…</div>
                ) : accounts.length === 0 ? (
                  <div className="px-5 py-12 text-center text-[12.5px] text-ds-t3">No accounts found</div>
                ) : (
                  accounts.map((acc: any) => {
                    const ps = platStyle(acc.platform);
                    const st = STATUS[acc.status] ?? { label: formatStatus(acc.status ?? ""), color: "#738395" };
                    const sync = syncAge(acc.lastSyncedAt);
                    const asg: any[] = acc.assignments ?? [];
                    const first = asg[0]?.employee?.name ? toTitleCase(asg[0].employee.name).split(" ")[0] : "";
                    const href = safeProfileHref(acc.profileUrl, acc.platform, acc.handle);
                    return (
                      <div key={acc.id} role="row" className={`${GRID} group h-[60px] px-6 border-b border-[#101E29] last:border-b-0 text-[12.5px] transition-colors hover:bg-[#0B1824]`}>
                        <span role="cell" className="flex items-center gap-3 min-w-0">
                          <PlatformTile platform={acc.platform} />
                          <span className="min-w-0 leading-[1.3]">
                            <span className="block font-semibold text-ds-text truncate">{acc.displayName}</span>
                            <span className="block text-[10.5px] text-ds-t3 truncate">{fmtHandle(acc.handle)}</span>
                          </span>
                        </span>
                        <span role="cell" className="flex justify-center">
                          {acc.platform?.name ? (
                            <span className="inline-flex items-center h-[22px] px-[9px] rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ background: rgba(ps.color, 0.12), borderColor: rgba(ps.color, 0.3), color: ps.color }}>
                              {acc.platform.name}
                            </span>
                          ) : <span className="text-ds-t4">—</span>}
                        </span>
                        <span role="cell" title={acc.clientName || undefined} className="text-ds-t2 truncate text-center">{acc.clientName || "—"}</span>
                        <span role="cell" className="flex items-center justify-center gap-2 min-w-0">
                          {asg.length > 0 ? (
                            <>
                              <span className="flex flex-wrap max-w-[132px] gap-y-1 shrink-0">
                                {asg.map((a: any) => {
                                  const name = toTitleCase(a.employee?.name ?? "");
                                  const av = avatar(name);
                                  return (
                                    <button
                                      key={a.id}
                                      type="button"
                                      title={`${name} — click to remove this assignment`}
                                      aria-label={`Remove ${name} from this account`}
                                      onClick={() => { if (a.employee?.id && window.confirm(`Remove ${name} from ${acc.displayName}?`)) handleUnassign(acc.id, a.employee.id); }}
                                      className="relative -mr-1.5 h-6 w-6 rounded-full border-2 border-ds-card grid place-items-center text-[9.5px] font-bold transition-transform hover:z-10 hover:scale-110 group/face"
                                      style={{ background: av.bg, color: av.fg }}
                                    >
                                      <span className="group-hover/face:hidden">{name[0]?.toUpperCase()}</span>
                                      <UserMinus className="hidden group-hover/face:block h-3 w-3 text-ds-redsoft" />
                                    </button>
                                  );
                                })}
                              </span>
                              <span className="ml-2 text-ds-t5 truncate">{asg.length > 1 ? `${first} +${asg.length - 1}` : first}</span>
                              <button
                                type="button"
                                onClick={() => openAssign({ accountId: acc.id })}
                                title="Assign another employee to this account"
                                aria-label="Assign another employee"
                                className="shrink-0 h-5 w-5 rounded-full border border-dashed border-ds-line4 text-ds-t3 grid place-items-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity hover:border-ds-teal hover:text-ds-teal"
                              >
                                <Plus className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openAssign({ accountId: acc.id })}
                              className="h-[22px] px-[9px] rounded-[11px] border border-dashed border-ds-line4 bg-transparent text-ds-t2 text-[10.5px] font-semibold whitespace-nowrap transition-colors hover:border-ds-teal hover:text-ds-teal"
                            >
                              + Assign
                            </button>
                          )}
                        </span>
                        <span role="cell" className="relative flex items-center justify-center font-semibold text-ds-text">
                          <button
                            type="button"
                            onClick={() => handleManualFollowerEdit(acc.id, acc.followerCount, acc.displayName)}
                            title="Edit follower count manually"
                            aria-label="Edit follower count"
                            className="absolute left-0 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-ds-t3 hover:text-ds-gold transition-opacity"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <span title={acc.followerCount != null ? acc.followerCount.toLocaleString() : undefined}>{fmtK(acc.followerCount)}</span>
                        </span>
                        <span role="cell" className={`text-center text-[11.5px] whitespace-nowrap ${sync.never ? "text-ds-t4" : sync.stale ? "text-[#FBBF24]" : "text-ds-t2"}`}>
                          {sync.label}
                        </span>
                        <span role="cell" className="flex justify-center">
                          <span className="inline-flex items-center gap-1.5 h-[22px] px-[9px] rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.28), color: st.color }}>
                            <i className="h-[5px] w-[5px] rounded-full" style={{ background: st.color }} />
                            {st.label}
                          </span>
                        </span>
                        <span role="cell" className="flex justify-center gap-1">
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" title="Open profile" aria-label="Open profile"
                              className="h-[26px] w-[26px] rounded-[6px] border border-ds-line2 text-ds-t2 grid place-items-center transition-colors hover:border-ds-line4 hover:text-ds-text">
                              <ExternalLink className="h-3 w-3" strokeWidth={1.8} />
                            </a>
                          ) : (
                            // Keeps edit/delete in the same position on every row when there is no profile link.
                            <span aria-hidden="true" className="h-[26px] w-[26px]" />
                          )}
                          <button type="button" onClick={() => setEditTarget(acc)} title="Edit" aria-label="Edit account"
                            className="h-[26px] w-[26px] rounded-[6px] border border-ds-line2 text-ds-t2 grid place-items-center transition-colors hover:border-ds-gold/55 hover:text-ds-gold">
                            <Pencil className="h-3 w-3" strokeWidth={1.8} />
                          </button>
                          <button type="button" onClick={() => setDeleteTarget(acc)} title="Delete" aria-label="Delete account"
                            className="h-[26px] w-[26px] rounded-[6px] border border-ds-line2 text-ds-t2 grid place-items-center transition-colors hover:border-ds-red/60 hover:text-ds-redsoft">
                            <Trash2 className="h-3 w-3" strokeWidth={1.8} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── TAB: By Employee ── */}
      {tab === "by-employee" && (
        <>
          <section className="flex items-center gap-2.5 flex-wrap mt-3.5">
            <label className="flex items-center gap-2 h-[34px] px-3 rounded-[17px] bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_300px] min-w-[200px] focus-within:border-ds-gold">
              <Search className="h-[13px] w-[13px] shrink-0" strokeWidth={1.8} />
              <input
                type="text"
                value={employeeSearch}
                onChange={(e) => setEmployeeSearch(e.target.value)}
                placeholder="Search employees…"
                aria-label="Search employees"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[12px] placeholder:text-ds-t3"
              />
            </label>
            <span className="ml-auto text-[11px] text-ds-t3">{visibleEmployees.length} employee{visibleEmployees.length === 1 ? "" : "s"}</span>
          </section>

          {employees.length === 0 ? (
            <div className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line px-5 py-12 text-center text-[12.5px] text-ds-t3">No active employees found</div>
          ) : visibleEmployees.length === 0 ? (
            <div className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line px-5 py-12 text-center text-[12.5px] text-ds-t3">No employees match &quot;{employeeSearch}&quot;</div>
          ) : (
            <section className="grid gap-3.5 mt-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
              {visibleEmployees.map((emp: any) => {
                const empAccounts = allAccounts.filter((a: any) =>
                  a.assignments?.some((asn: any) => !asn.unassignedAt && asn.employee?.id === emp.id)
                );
                const name = toTitleCase(emp.name);
                const av = avatar(name);
                const tot = empAccounts.reduce((s, a) => s + (a.followerCount ?? 0), 0);
                return (
                  <div key={emp.id} className="rounded-[8px] bg-ds-card border border-ds-line px-[18px] py-4 flex flex-col gap-3 min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="h-9 w-9 rounded-full border border-ds-line2 grid place-items-center text-[13px] font-bold shrink-0" style={{ background: av.bg, color: av.fg }}>
                        {name[0]?.toUpperCase()}
                      </span>
                      <div className="flex-1 min-w-0 leading-[1.3]">
                        <p className="text-[13px] font-semibold text-ds-text truncate">{name}</p>
                        <p className="text-[10.5px] text-ds-t3 truncate">
                          {empAccounts.length > 0
                            ? `${empAccounts.length} account${empAccounts.length > 1 ? "s" : ""} · ${fmtK(tot)} followers`
                            : emp.designation || emp.email}
                        </p>
                      </div>
                      <button
                        onClick={() => openAssign({ employeeId: emp.id })}
                        className="h-[26px] px-2.5 rounded-[13px] border border-ds-line2 bg-ds-inset text-ds-t2 text-[11px] font-semibold whitespace-nowrap transition-colors hover:border-ds-teal hover:text-ds-teal shrink-0"
                      >
                        + Assign
                      </button>
                    </div>

                    {empAccounts.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        {empAccounts.map((a: any) => (
                          <div key={a.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-[6px] bg-ds-inset border border-[#101E29]">
                            <PlatformTile platform={a.platform} size={24} />
                            <span className="flex-1 min-w-0 text-[11.5px] font-semibold text-ds-text truncate" title={`${a.platform?.name ?? ""} · ${a.handle}`}>
                              {a.displayName || fmtHandle(a.handle)}
                            </span>
                            <span className="text-[11px] text-ds-t2">{fmtK(a.followerCount)}</span>
                            <button
                              type="button"
                              title="Unassign"
                              aria-label={`Unassign ${a.displayName || a.handle}`}
                              onClick={() => {
                                const asn = a.assignments?.find((x: any) => !x.unassignedAt && x.employee?.id === emp.id);
                                if (asn) handleUnassign(a.id, emp.id);
                              }}
                              className="h-[22px] w-[22px] rounded-[5px] border border-ds-line2 text-ds-t3 grid place-items-center transition-colors hover:border-ds-red/60 hover:text-ds-redsoft shrink-0"
                            >
                              <UserMinus className="h-[11px] w-[11px]" strokeWidth={1.8} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-ds-t4 px-0.5">No accounts assigned</p>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </>
      )}

      {/* ── TAB: Platforms ── */}
      {tab === "platforms" && (
        platforms.length === 0 ? (
          <div className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line px-5 py-12 text-center text-[12.5px] text-ds-t3">No platforms configured</div>
        ) : (
          <section className="grid gap-3.5 mt-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
            {platforms.map((p: any) => {
              const s = platStyle(p);
              const pAccounts = allAccounts.filter((a: any) => a.platform?.id === p.id);
              const assigned = pAccounts.filter((a: any) => a.assignments?.length > 0).length;
              const pActive = pAccounts.filter((a: any) => a.status === "ACTIVE").length;
              const pct = pAccounts.length ? Math.round((assigned / pAccounts.length) * 100) : 0;
              const followers = pAccounts.reduce((sum, a) => sum + (a.followerCount ?? 0), 0);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setPlatformFilter(p.id); setTab("accounts"); }}
                  title={`View ${p.name} accounts`}
                  className="relative flex flex-col gap-3.5 p-[18px] rounded-[8px] bg-ds-card border border-ds-line text-left text-ds-text overflow-hidden transition-colors"
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = rgba(s.color, 0.4); }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = ""; }}
                >
                  <span className="absolute left-0 right-0 top-0 h-0.5" style={{ background: s.color }} />
                  <span className="flex items-center gap-3">
                    <span className="h-10 w-10 rounded-[10px] grid place-items-center border text-[11px] font-extrabold" style={{ background: rgba(s.color, 0.12), borderColor: rgba(s.color, 0.4), color: s.color }}>
                      {s.abbr}
                    </span>
                    <span>
                      <span className="block text-[14px] font-semibold">{p.name}</span>
                      <span className="block text-[10.5px] text-ds-t3">{s.sync}</span>
                    </span>
                  </span>
                  <span className="grid grid-cols-3 gap-2.5">
                    <span>
                      <span className="block text-[22px] font-semibold tracking-[-.02em]">{kpiReady ? pAccounts.length : "—"}</span>
                      <span className="block text-[10.5px] text-ds-t3">accounts</span>
                    </span>
                    <span>
                      <span className="block text-[22px] font-semibold tracking-[-.02em] text-ds-teal">{kpiReady ? pActive : "—"}</span>
                      <span className="block text-[10.5px] text-ds-t3">active</span>
                    </span>
                    <span>
                      <span className="block text-[22px] font-semibold tracking-[-.02em]">{kpiReady ? fmtK(followers) : "—"}</span>
                      <span className="block text-[10.5px] text-ds-t3">followers</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="flex-1 h-1 rounded-[2px] bg-[#132430] overflow-hidden">
                      <span className="block h-full" style={{ width: `${pct}%`, background: s.color }} />
                    </span>
                    <span className="text-[10.5px] text-ds-t2 whitespace-nowrap">{assigned}/{pAccounts.length} assigned</span>
                  </span>
                </button>
              );
            })}
          </section>
        )
      )}
    </div>
  );
}

export default function AccountsPage() {
  return (
    <Suspense>
      <AccountsPageInner />
    </Suspense>
  );
}
