"use client";
import { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccounts, usePlatforms } from "@/lib/hooks/use-accounts";
import { useEmployees } from "@/lib/hooks/use-employees";
import { formatStatus, toTitleCase } from "@dashmani/shared";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  Globe, Plus, Search, Pencil, Trash2, X, Share2, ChevronDown,
  Users, LayoutGrid, ExternalLink, UserMinus, Check, RefreshCw,
} from "lucide-react";
import { PlatformIcon } from "@/lib/platform-icon";
import { ModalPortal } from "@/components/modal-portal";

type Tab = "accounts" | "by-employee" | "platforms";

// Normalize a profile URL for use as an href:
// 1. Add https:// if the URL has no scheme (e.g. "www.snapchat.com/add/handle").
// 2. Fix Snapchat /add/@handle → /add/handle (@ in that path returns a "Sorry" page).
function safeProfileHref(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null;
  let raw = url.trim();
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/\//, "");
  try {
    new URL(raw); // validate
  } catch {
    return null;
  }
  return raw.replace(/(snapchat\.com\/add\/)@([^/?#]+)/i, "$1$2");
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE:   "bg-sage-soft text-sage",
  PAUSED:   "bg-attention/10 text-attention",
  ARCHIVED: "bg-muted text-ink-4",
};

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

  const inputCls = "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors focus:outline-none focus:border-indigo";

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
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      {/* Dim backdrop */}
      <div className="flex-1 bg-ink/40" />

      {/* Slide-in panel */}
      <div
        className="w-full max-w-md bg-bg border-l-2 border-ink/10 flex flex-col shadow-pop overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-ink/10 shrink-0">
          <h2 className="font-bold text-ink flex items-center gap-2">
            <Globe size={17} className="text-indigo" />
            {isEdit ? "Edit Account" : "Add Social Account"}
          </h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-ink-4 text-xl leading-none">×</button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 p-6 space-y-4">
          {!isEdit && (
            <div>
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">Platform</label>
              <div className="relative">
                <select
                  value={form.platformId}
                  onChange={(e) => setForm({ ...form, platformId: e.target.value })}
                  required
                  className={`${inputCls} appearance-none pr-8`}
                >
                  <option value="">Select platform…</option>
                  {platforms.map((p: any) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
              </div>
            </div>
          )}

          {(["handle", "displayName", "clientName", "profileUrl"] as const).map((field) => (
            <div key={field}>
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">
                {field === "handle"      ? "Handle"
                : field === "displayName" ? "Display Name"
                : field === "clientName"  ? "Client Name (optional)"
                : "Profile URL (optional)"}
              </label>
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
                className={inputCls}
              />
            </div>
          ))}

          {isEdit && (
            <div>
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">Status</label>
              <div className="relative">
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className={`${inputCls} appearance-none pr-8`}
                >
                  {["ACTIVE", "PAUSED", "ARCHIVED"].map((s) => (
                    <option key={s} value={s}>{formatStatus(s)}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
              </div>
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Check size={14} />
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

  const inputCls = "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink transition-colors focus:outline-none focus:border-indigo appearance-none pr-8";

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

  if (done) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="v3-card shadow-pop p-8 text-center w-full max-w-sm pop-in">
        <div className="h-14 w-14 rounded-xl bg-sage flex items-center justify-center mx-auto mb-4">
          <Share2 className="h-7 w-7 text-white" />
        </div>
        <p className="text-lg font-bold text-ink font-display">Assigned!</p>
        <p className="text-sm text-ink-3 mt-1">
          <span className="font-semibold text-ink">{done.name}</span> → <span className="font-semibold text-ink">@{done.handle}</span>
        </p>
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={() => { setDone(null); setSelectedAccount(""); }}
            className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors"
          >
            Assign another
          </button>
          <button onClick={onClose} className="px-6 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="v3-card shadow-pop w-full max-w-lg overflow-hidden pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-ink/10">
          <h2 className="font-bold text-ink flex items-center gap-2">
            <Share2 size={17} className="text-sage" />
            Assign Account
          </h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-ink-4 text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">
              Employee <span className="text-ink-4 font-normal normal-case">({employees.length} available)</span>
            </label>
            <div className="relative">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
                <input
                  type="text"
                  value={empOpen ? empSearch : (selectedEmployeeName || empSearch)}
                  onChange={(e) => { setEmpSearch(e.target.value); setEmpOpen(true); if (selectedEmployee) setSelectedEmployee(""); }}
                  onFocus={() => { setEmpOpen(true); setEmpSearch(""); }}
                  onBlur={() => setTimeout(() => setEmpOpen(false), 150)}
                  placeholder="Type a name to search…"
                  className={`${inputCls} pl-9 pr-8`}
                  autoComplete="off"
                />
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
              </div>
              {empOpen && (
                <div className="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto bg-white border-2 border-ink/15 rounded-xl shadow-lg">
                  {filteredEmployees.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-ink-4">No employees match "{empSearch}"</div>
                  ) : (
                    filteredEmployees.map((e: any) => (
                      <button
                        key={e.id}
                        type="button"
                        onMouseDown={(ev) => { ev.preventDefault(); setSelectedEmployee(e.id); setSelectedAccount(""); setEmpSearch(""); setEmpOpen(false); }}
                        className={`w-full text-left px-4 py-2 text-sm hover:bg-muted transition-colors flex items-center justify-between ${selectedEmployee === e.id ? "bg-indigo-soft" : ""}`}
                      >
                        <span className="text-ink">{e.name}</span>
                        {e.designation && <span className="text-xs text-ink-4 ml-2">{e.designation}</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {selectedEmployee && (
            <div>
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">Social Account</label>
              <div className="relative">
                <select
                  value={selectedAccount}
                  onChange={(e) => setSelectedAccount(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Select account…</option>
                  {accounts.map((a: any) => {
                    const already = assignedAccountIds.has(a.id);
                    return (
                      <option key={a.id} value={a.id} disabled={already}>
                        {a.platform?.name ? `[${a.platform.name}] ` : ""}{a.handle}{a.displayName ? ` — ${a.displayName}` : ""}{already ? " (already assigned)" : ""}
                      </option>
                    );
                  })}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4 pointer-events-none" />
              </div>
              {selectedAccountData && (
                <p className="text-xs text-ink-4 mt-1.5">
                  {selectedAccountData.platform?.name} · @{selectedAccountData.handle}
                  {selectedAccountData.followerCount ? ` · ${selectedAccountData.followerCount.toLocaleString()} followers` : ""}
                  {selectedAccountData.clientName ? ` · ${selectedAccountData.clientName}` : ""}
                </p>
              )}
            </div>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button onClick={onClose} className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors">Cancel</button>
            <button
              onClick={handleAssign}
              disabled={!selectedEmployee || !selectedAccount || submitting}
              className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Share2 size={14} />
              {submitting ? "Assigning…" : "Assign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Delete confirm modal ── */
function DeleteModal({ target, onCancel, onConfirm, deleting }: {
  target: any; onCancel: () => void; onConfirm: () => void; deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4" onClick={() => !deleting && onCancel()}>
      <div className="v3-card shadow-pop w-full max-w-md pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-5 flex items-start gap-4">
          <div className="h-10 w-10 rounded-xl bg-danger/10 flex items-center justify-center shrink-0">
            <Trash2 className="h-5 w-5 text-danger" />
          </div>
          <div>
            <p className="font-semibold text-ink">Delete account?</p>
            <p className="text-sm text-ink-4 mt-1">
              Permanently deletes <strong>{target.displayName}</strong> ({target.handle}). If it has tasks, posts, or report links, archive it instead.
            </p>
          </div>
        </div>
        <div className="px-6 py-4 border-t-2 border-ink/10 flex items-center justify-end gap-2">
          <button onClick={onCancel} disabled={deleting} className="px-4 py-2 text-sm text-ink-4 hover:text-ink transition-colors disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={deleting} className="px-4 py-2 bg-danger text-white rounded-full text-sm font-semibold hover:bg-danger/90 disabled:opacity-50 transition-colors">
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
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
  const { data: platformData }            = usePlatforms();
  const { data: employeeData }            = useEmployees({ status: "ACTIVE", limit: 500 });
  const accounts  = (data as any)?.data ?? [];
  // `has_more` is true only if the server had more rows than the 500 ceiling.
  // We surface it so the list can never silently hide accounts again.
  const accountsTruncated = (data as any)?.meta?.has_more === true;
  const platforms = (platformData as any)?.data ?? [];
  const employees = ((employeeData as any)?.data ?? []).slice().sort((a: any, b: any) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );

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
            mutate();
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

  async function handleManualFollowerEdit(accountId: string, currentValue: number | null | undefined) {
    const input = window.prompt(
      "Enter follower count (digits only; supports K / M shorthand, e.g. 14M, 553K, 1200000):",
      currentValue ? String(currentValue) : ""
    );
    if (input === null) return; // cancelled
    const trimmed = input.trim().toUpperCase();
    if (!trimmed) return;
    // Parse client-side so the user sees errors immediately
    let n: number;
    const m = trimmed.match(/^([\d.,]+)\s*([KM])?$/);
    if (!m) { alert("Invalid number. Use digits only or shorthand like 14M, 553K."); return; }
    n = parseFloat(m[1].replace(/,/g, ""));
    if (m[2] === "K") n *= 1000;
    if (m[2] === "M") n *= 1000000;
    if (isNaN(n) || n < 0) { alert("Invalid number."); return; }
    try {
      await apiFetch(`/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({ followerCount: Math.round(n) }),
      });
      mutate();
    } catch (err: any) {
      alert(err?.message || "Failed to update follower count");
    }
  }
  const [assignOpen, setAssignOpen]         = useState(false);
  const [assignEmployeeId, setAssignEmployeeId] = useState<string | undefined>();
  const [assignAccountId, setAssignAccountId]   = useState<string | undefined>();

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
      mutate();
    } catch (err: any) {
      alert(err?.message || "Failed to delete account");
    } finally {
      setDeleting(false);
    }
  }

  async function handleUnassign(accountId: string, employeeId: string) {
    try {
      await apiFetch(`/accounts/${accountId}/assign/${employeeId}`, { method: "DELETE" });
      mutate();
    } catch (err: any) {
      alert(err?.message || "Failed to unassign");
    }
  }

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "accounts",     label: "All Accounts",  icon: Globe   },
    { id: "by-employee",  label: "By Employee",   icon: Users   },
    { id: "platforms",    label: "Platforms",      icon: LayoutGrid },
  ];

  return (
    <div className="space-y-5 pop-in">
      {/* Modals — portalled to document.body so fixed positioning isn't affected by any transformed ancestor */}
      <ModalPortal>
        {(createOpen || editTarget) && (
          <AccountPanel
            account={editTarget ?? undefined}
            platforms={platforms}
            onClose={() => { setCreateOpen(false); setEditTarget(null); }}
            onSaved={() => { setCreateOpen(false); setEditTarget(null); mutate(); }}
          />
        )}
        {assignOpen && (
          <AssignModal
            accounts={accounts}
            employees={employees}
            preselectedEmployeeId={assignEmployeeId}
            preselectedAccountId={assignAccountId}
            onClose={() => { setAssignOpen(false); setAssignEmployeeId(undefined); setAssignAccountId(undefined); }}
            onDone={() => mutate()}
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
      </ModalPortal>

      {/* Page header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-bold text-ink-4 uppercase tracking-widest mb-0.5">Social Media</p>
          <h1 className="font-display text-2xl font-semibold text-ink">Accounts</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSyncFollowers}
            disabled={syncing}
            className="flex items-center gap-2 h-9 px-4 rounded-full border-2 border-ink/15 text-sm font-semibold text-ink-3 hover:border-indigo/40 hover:text-indigo transition-colors disabled:opacity-50"
            title="Re-fetch follower counts for Instagram, YouTube and Facebook accounts (other platforms must be entered manually)"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing
              ? syncProgress && syncProgress.total > 0
                ? `Syncing ${syncProgress.processed}/${syncProgress.total}…`
                : "Syncing…"
              : "Sync Followers"}
          </button>
          <button
            onClick={() => openAssign({})}
            className="flex items-center gap-2 h-9 px-4 rounded-full border-2 border-ink/15 text-sm font-semibold text-ink-3 hover:border-sage/40 hover:text-sage transition-colors"
          >
            <Share2 className="h-3.5 w-3.5" /> Assign
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="flex items-center gap-2 h-9 px-4 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" /> Add Account
          </button>
        </div>
      </div>

      {/* Sync status banner */}
      {syncToast && (
        <div className="bg-indigo-soft border-2 border-indigo/20 rounded-2xl px-4 py-3 flex items-center gap-3">
          <RefreshCw className={`h-4 w-4 text-indigo ${syncing ? "animate-spin" : ""} shrink-0`} />
          <div className="flex-1 text-sm text-ink">
            <p className="font-semibold">{syncToast}</p>
            {syncing && syncProgress && syncProgress.total > 0 && (
              <p className="text-xs text-ink-3 mt-0.5">
                {syncProgress.processed} of {syncProgress.total} processed — {syncProgress.updated} updated, {syncProgress.failed} failed, {syncProgress.skipped} skipped
              </p>
            )}
          </div>
          <button
            onClick={() => { setSyncToast(null); }}
            className="text-ink-4 hover:text-ink"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b-2 border-ink/10">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-[2px] transition-colors ${
              tab === id
                ? "border-indigo text-indigo"
                : "border-transparent text-ink-4 hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── TAB: All Accounts ── */}
      {tab === "accounts" && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
              <input
                type="text"
                placeholder="Search accounts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-9 pl-9 pr-3 rounded-xl border-2 border-ink/15 bg-surface text-sm focus:outline-none focus:border-indigo transition-colors"
              />
            </div>
            <div className="relative">
              <select
                value={platformFilter}
                onChange={(e) => setPlatformFilter(e.target.value)}
                className="h-9 pl-3 pr-8 rounded-xl border-2 border-ink/15 bg-surface text-sm focus:outline-none focus:border-indigo transition-colors appearance-none"
              >
                <option value="">All Platforms</option>
                {platforms.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-4 pointer-events-none" />
            </div>
            {(search || platformFilter) && (
              <button onClick={() => { setSearch(""); setPlatformFilter(""); }} className="h-9 px-3 rounded-xl border-2 border-ink/15 text-sm text-ink-4 hover:text-danger hover:border-danger/30 transition-colors flex items-center gap-1">
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            )}
          </div>

          {/* Result count — so truncation / empty states are never ambiguous */}
          {!isLoading && (
            <p className="text-xs text-ink-4 -mt-1">
              {search || platformFilter
                ? `${accounts.length} result${accounts.length === 1 ? "" : "s"}`
                : `Showing ${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
              {accountsTruncated && (
                <span className="ml-2 text-terra font-semibold">
                  · showing the first 500 — narrow your search to see the rest
                </span>
              )}
            </p>
          )}

          {/* Accounts table */}
          <div className="v3-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-ink/10">
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Account</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Platform</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Client</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Assigned To</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Followers</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider hidden xl:table-cell">Last Synced</th>
                    <th className="text-left px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Status</th>
                    <th className="text-right px-4 py-3 text-[11px] font-bold text-ink-4 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-ink-4">Loading…</td></tr>
                  ) : accounts.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-ink-4">No accounts found</td></tr>
                  ) : (
                    accounts.map((acc: any) => (
                      <tr key={acc.id} className="border-b border-ink/8 last:border-0 hover:bg-muted/40 transition-colors group">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="h-8 w-8 rounded-lg bg-indigo-soft flex items-center justify-center shrink-0">
                              <PlatformIcon slug={acc.platform?.slug} className="h-4 w-4 text-indigo" />
                            </div>
                            <div>
                              <p className="font-semibold text-ink text-sm">{acc.displayName}</p>
                              <p className="text-xs text-ink-4">{acc.handle}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-block bg-terra-soft text-terra text-xs font-semibold px-2.5 py-1 rounded-full">
                            {acc.platform?.name}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-ink-4">{acc.clientName || "—"}</td>
                        <td className="px-4 py-3">
                          {acc.assignments?.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {acc.assignments.map((a: any) => (
                                <div key={a.id} className="flex items-center gap-1.5">
                                  <div className="h-5 w-5 rounded-full bg-indigo flex items-center justify-center text-white text-[9px] font-bold shrink-0">
                                    {a.employee?.name?.[0]?.toUpperCase()}
                                  </div>
                                  <span className="text-xs text-ink">{toTitleCase(a.employee?.name)}</span>
                                  <button
                                    onClick={() => handleUnassign(acc.id, a.employee.id)}
                                    className="opacity-0 group-hover:opacity-100 text-ink-4 hover:text-danger transition-all"
                                    title="Remove assignment"
                                  >
                                    <UserMinus className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={() => openAssign({ accountId: acc.id })}
                                className="mt-1 text-[11px] text-ink-4 hover:text-sage flex items-center gap-1 transition-colors w-fit"
                                title="Assign another employee to this account"
                              >
                                <Plus className="h-3 w-3" /> Add another
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => openAssign({ accountId: acc.id })}
                              className="text-xs text-ink-4 hover:text-sage flex items-center gap-1 transition-colors"
                            >
                              <Plus className="h-3 w-3" /> Assign
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-ink-4">
                          <div className="flex items-center gap-1.5">
                            <span>{acc.followerCount?.toLocaleString() ?? "—"}</span>
                            <button
                              onClick={() => handleManualFollowerEdit(acc.id, acc.followerCount)}
                              className="opacity-0 group-hover:opacity-100 hover:text-indigo transition-opacity"
                              title="Edit follower count manually"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-ink-4 hidden xl:table-cell">
                          {acc.lastSyncedAt
                            ? (() => {
                                const diff = Date.now() - new Date(acc.lastSyncedAt).getTime();
                                const mins = Math.floor(diff / 60000);
                                const hrs = Math.floor(mins / 60);
                                const days = Math.floor(hrs / 24);
                                return days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : mins > 1 ? `${mins}m ago` : "Just now";
                              })()
                            : "Never"}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[acc.status] ?? "bg-muted text-ink-4"}`}>
                            {formatStatus(acc.status)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {safeProfileHref(acc.profileUrl) && (
                              <a
                                href={safeProfileHref(acc.profileUrl)!}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="p-1.5 rounded-lg text-ink-4 hover:bg-muted hover:text-indigo transition-colors"
                                title="Open profile"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            )}
                            <button
                              onClick={() => setEditTarget(acc)}
                              className="p-1.5 rounded-lg text-ink-4 hover:bg-indigo-soft hover:text-indigo transition-colors"
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteTarget(acc)}
                              className="p-1.5 rounded-lg text-ink-4 hover:bg-danger/10 hover:text-danger transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── TAB: By Employee ── */}
      {tab === "by-employee" && (
        <div className="space-y-3">
          <div className="relative max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
            <input
              type="text"
              value={employeeSearch}
              onChange={(e) => setEmployeeSearch(e.target.value)}
              placeholder="Search employees…"
              className="w-full pl-9 pr-3 py-2 rounded-xl border-2 border-ink/15 bg-surface text-sm"
            />
          </div>
          {employees.length === 0 ? (
            <div className="v3-card p-8 text-center text-sm text-ink-4">No active employees found</div>
          ) : employees.filter((e: any) => !employeeSearch.trim() || e.name?.toLowerCase().includes(employeeSearch.trim().toLowerCase())).length === 0 ? (
            <div className="v3-card p-8 text-center text-sm text-ink-4">No employees match "{employeeSearch}"</div>
          ) : (
            employees.filter((e: any) => !employeeSearch.trim() || e.name?.toLowerCase().includes(employeeSearch.trim().toLowerCase())).map((emp: any) => {
              const empAccounts = accounts.filter((a: any) =>
                a.assignments?.some((asn: any) => !asn.unassignedAt && asn.employee?.id === emp.id)
              );
              return (
                <div key={emp.id} className="v3-card p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-9 w-9 rounded-full bg-indigo flex items-center justify-center text-white text-sm font-bold shrink-0">
                        {emp.name?.[0]?.toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-ink text-sm truncate">{toTitleCase(emp.name)}</p>
                        <p className="text-xs text-ink-4 truncate">{emp.designation || emp.email}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => openAssign({ employeeId: emp.id })}
                      className="flex items-center gap-1.5 h-8 px-3 rounded-full border-2 border-ink/12 text-xs font-semibold text-ink-4 hover:border-sage/40 hover:text-sage transition-colors shrink-0"
                    >
                      <Plus className="h-3 w-3" /> Assign
                    </button>
                  </div>

                  {empAccounts.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {empAccounts.map((a: any) => (
                        <div key={a.id} className="flex items-center gap-1.5 bg-muted/60 rounded-full pl-2.5 pr-1.5 py-1">
                          <span className="text-xs font-semibold text-ink">{a.platform?.name}</span>
                          <span className="text-xs text-ink-4">@{a.handle}</span>
                          <button
                            onClick={() => {
                              const asn = a.assignments?.find((x: any) => !x.unassignedAt && x.employee?.id === emp.id);
                              if (asn) handleUnassign(a.id, emp.id);
                            }}
                            className="ml-1 h-4 w-4 rounded-full bg-ink/8 hover:bg-danger/15 hover:text-danger flex items-center justify-center text-ink-4 transition-colors"
                            title="Remove"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-ink-4 pl-12">No accounts assigned</p>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ── TAB: Platforms ── */}
      {tab === "platforms" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {platforms.length === 0 ? (
            <div className="v3-card p-8 text-center text-sm text-ink-4 col-span-full">No platforms configured</div>
          ) : (
            platforms.map((p: any) => {
              const pAccounts = accounts.filter((a: any) => a.platform?.id === p.id);
              const activeCount = pAccounts.filter((a: any) => a.status === "ACTIVE").length;
              const assignedCount = pAccounts.filter((a: any) => a.assignments?.length > 0).length;
              return (
                <div key={p.id} className="v3-card p-5 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
                      <PlatformIcon slug={p.slug} className="h-5 w-5 text-indigo" />
                    </div>
                    <div>
                      <p className="font-bold text-ink">{p.name}</p>
                      <p className="text-xs text-ink-4">/{p.slug}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-center">
                    <div>
                      <p className="font-num text-xl font-semibold text-ink leading-none">{pAccounts.length}</p>
                      <p className="text-[10px] text-ink-4 mt-0.5">Total</p>
                    </div>
                    <div className="w-px h-8 bg-ink/10" />
                    <div>
                      <p className="font-num text-xl font-semibold text-sage leading-none">{activeCount}</p>
                      <p className="text-[10px] text-ink-4 mt-0.5">Active</p>
                    </div>
                    <div className="w-px h-8 bg-ink/10" />
                    <div>
                      <p className="font-num text-xl font-semibold text-terra leading-none">{assignedCount}</p>
                      <p className="text-[10px] text-ink-4 mt-0.5">Assigned</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setPlatformFilter(p.id); setTab("accounts"); }}
                    className="w-full h-8 rounded-xl border-2 border-ink/12 text-xs font-semibold text-ink-4 hover:border-indigo/30 hover:text-indigo transition-colors"
                  >
                    View accounts →
                  </button>
                </div>
              );
            })
          )}
        </div>
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
