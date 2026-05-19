"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { User, Lock, AlertCircle, Check } from "lucide-react";

const inputCls =
  "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors";

export default function SettingsPage() {
  usePageTitle("Settings");
  const { user } = useAuth();

  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwState, setPwState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [pwError, setPwError] = useState("");

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    if (pwForm.next.length < 8) {
      setPwError("New password must be at least 8 characters.");
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwError("New passwords do not match.");
      return;
    }
    setPwState("loading");
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: pwForm.current,
          newPassword: pwForm.next,
        }),
      });
      setPwState("success");
      setPwForm({ current: "", next: "", confirm: "" });
      setTimeout(() => setPwState("idle"), 3000);
    } catch (err: any) {
      setPwError(err?.message || "Failed to change password.");
      setPwState("error");
    }
  }

  return (
    <div className="space-y-8 crx-animate-fade max-w-2xl">
      <div>
        <h1 className="font-serif text-4xl font-light text-ink">Settings</h1>
        <p className="text-sm text-ink-3 mt-1">Manage your account preferences.</p>
      </div>

      {/* Profile card */}
      <div className="v3-card p-6 space-y-4">
        <h2 className="font-semibold text-ink flex items-center gap-2 text-base">
          <User size={16} className="text-ink-4" /> Profile
        </h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-ink-4 text-xs font-medium mb-1">Name</p>
            <p className="text-ink font-semibold">{user?.name ?? "—"}</p>
          </div>
          <div>
            <p className="text-ink-4 text-xs font-medium mb-1">Email</p>
            <p className="text-ink font-semibold">{user?.email ?? "—"}</p>
          </div>
          <div>
            <p className="text-ink-4 text-xs font-medium mb-1">Roles</p>
            <p className="text-ink font-semibold">{user?.roles?.join(", ") ?? "—"}</p>
          </div>
        </div>
        <p className="text-xs text-ink-4">
          To update your name or email contact an admin or update your profile via the Employees page.
        </p>
      </div>

      {/* Change password */}
      <div className="v3-card p-6">
        <h2 className="font-semibold text-ink flex items-center gap-2 text-base mb-4">
          <Lock size={16} className="text-ink-4" /> Change Password
        </h2>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Current password</label>
            <input
              type="password"
              value={pwForm.current}
              onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
              required
              autoComplete="current-password"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">New password</label>
            <input
              type="password"
              value={pwForm.next}
              onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
              required
              autoComplete="new-password"
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Confirm new password</label>
            <input
              type="password"
              value={pwForm.confirm}
              onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
              required
              autoComplete="new-password"
              className={inputCls}
            />
          </div>

          {pwError && (
            <div className="flex items-center gap-2 text-danger text-sm font-medium">
              <AlertCircle size={14} /> {pwError}
            </div>
          )}
          {pwState === "success" && (
            <div className="flex items-center gap-2 text-success text-sm font-medium">
              <Check size={14} /> Password changed successfully.
            </div>
          )}

          <button
            type="submit"
            disabled={pwState === "loading"}
            className="bg-ink text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors"
          >
            {pwState === "loading" ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>
    </div>
  );
}
