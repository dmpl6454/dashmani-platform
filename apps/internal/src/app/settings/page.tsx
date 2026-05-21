"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { User, Lock, AlertCircle, Check, Eye, EyeOff } from "lucide-react";

const inputCls =
  "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors";

export default function SettingsPage() {
  usePageTitle("Settings");
  const { user } = useAuth();

  const [profileForm, setProfileForm] = useState({ name: user?.name ?? "" });
  const [profileState, setProfileState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [profileError, setProfileError] = useState("");

  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwState, setPwState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [pwError, setPwError] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  async function handleUpdateProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError("");
    if (!profileForm.name.trim() || profileForm.name.trim().length < 2) {
      setProfileError("Name must be at least 2 characters.");
      return;
    }
    setProfileState("loading");
    try {
      const updated = await apiFetch<any>("/auth/me", {
        method: "PUT",
        body: JSON.stringify({ name: profileForm.name.trim() }),
      });
      void updated;
      setProfileState("success");
      setTimeout(() => setProfileState("idle"), 3000);
    } catch (err: any) {
      setProfileError(err?.message || "Failed to update profile.");
      setProfileState("error");
    }
  }

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
        <form onSubmit={handleUpdateProfile} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Name</label>
              <input
                type="text"
                value={profileForm.name}
                onChange={(e) => setProfileForm({ name: e.target.value })}
                required
                autoComplete="name"
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Email</label>
              <p className="w-full border-2 border-ink/10 bg-surface/60 rounded-xl px-4 py-2.5 text-sm text-ink-3 select-all">
                {user?.email ?? "—"}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Roles</label>
              <p className="text-ink font-semibold text-sm">{user?.roles?.join(", ") ?? "—"}</p>
            </div>
          </div>

          {profileError && (
            <div className="flex items-center gap-2 text-danger text-sm font-medium">
              <AlertCircle size={14} /> {profileError}
            </div>
          )}
          {profileState === "success" && (
            <div className="flex items-center gap-2 text-success text-sm font-medium">
              <Check size={14} /> Profile updated.
            </div>
          )}

          <button
            type="submit"
            disabled={profileState === "loading"}
            className="bg-ink text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors"
          >
            {profileState === "loading" ? "Saving…" : "Save profile"}
          </button>
        </form>
      </div>

      {/* Change password */}
      <div className="v3-card p-6">
        <h2 className="font-semibold text-ink flex items-center gap-2 text-base mb-4">
          <Lock size={16} className="text-ink-4" /> Change Password
        </h2>
        <form onSubmit={handleChangePassword} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Current password</label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={pwForm.current}
                onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                required
                autoComplete="current-password"
                className={inputCls + " pr-10"}
              />
              <button type="button" onClick={() => setShowCurrent((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink">
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">New password</label>
            <div className="relative">
              <input
                type={showNext ? "text" : "password"}
                value={pwForm.next}
                onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                required
                autoComplete="new-password"
                className={inputCls + " pr-10"}
              />
              <button type="button" onClick={() => setShowNext((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink">
                {showNext ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-3 mb-1">Confirm new password</label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={pwForm.confirm}
                onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                required
                autoComplete="new-password"
                className={inputCls + " pr-10"}
              />
              <button type="button" onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink">
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
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
