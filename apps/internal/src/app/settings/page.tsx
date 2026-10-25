"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch, apiUpload, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { ModalPortal } from "@/components/modal-portal";
import Cropper from "react-easy-crop";

type Area = { x: number; y: number; width: number; height: number };

// Canvas crop from the pixel area returned by react-easy-crop
function getCroppedBlob(dataUrl: string, pixelCrop: Area, outputSize: number, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = outputSize;
      canvas.height = outputSize;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("Canvas unsupported"));
      ctx.drawImage(img, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height, 0, 0, outputSize, outputSize);
      const outMime = mime === "image/png" ? "image/png" : "image/jpeg";
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob failed")), outMime, 0.9);
    };
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = dataUrl;
  });
}

const IC = {
  camera: "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  mail: "M4 4h16v16H4zM22 6l-10 7L2 6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  alert: "M12 8v4M12 16h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z",
  check: "M20 6L9 17l-5-5",
  close: "M18 6L6 18M6 6l12 12",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M1 1l22 22M14.1 14.1a3 3 0 1 1-4.2-4.2",
};

function Icon({ d, className = "h-4 w-4", sw = 1.9 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Msg({ kind, children }: { kind: "err" | "ok"; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-2 text-[13px] font-semibold ${kind === "err" ? "text-[color:var(--hx-FB7185)]" : "text-ds-teal"}`} role={kind === "err" ? "alert" : "status"}>
      <Icon d={kind === "err" ? IC.alert : IC.check} className="h-3.5 w-3.5" sw={2.2} />
      <span>{children}</span>
    </div>
  );
}

const CARD =
  "relative rounded-[20px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_14px_36px_rgba(0,0,0,.32)] overflow-hidden";
const TOP_LINE =
  "absolute left-0 right-0 top-0 h-px opacity-60 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]";
const LABEL = "block text-[10.5px] font-bold tracking-[.14em] uppercase text-ds-t3 mb-2";
const FIELD =
  "w-full h-12 px-[18px] rounded-[14px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[14px] outline-none focus:border-[rgba(233,189,98,.6)] min-w-0";
const GOLD_BTN =
  "inline-flex items-center gap-2 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";

const imgSrc = (u: string) => (u.startsWith("http") ? u : `${API_BASE}${u}`);

export default function SettingsPage() {
  usePageTitle("Settings");
  const { user } = useAuth();

  const [profileForm, setProfileForm] = useState({ name: user?.name ?? "" });
  const [profileState, setProfileState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [profileError, setProfileError] = useState("");
  const [savedName, setSavedName] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [photoState, setPhotoState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [photoError, setPhotoError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(user?.profileImageUrl ?? null);

  // Lightbox — click avatar to preview full-size
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // In-page confirmation for removing the photo (replaces window.confirm)
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Cropper state
  const [editor, setEditor] = useState<{ dataUrl: string; mime: string } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const isPhotoLoading = photoState === "loading";

  useEffect(() => {
    if (!lightboxOpen && !editor && !confirmRemove) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isPhotoLoading) return;
      if (confirmRemove) setConfirmRemove(false);
      else if (editor) setEditor(null);
      else if (lightboxOpen) setLightboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, editor, confirmRemove, isPhotoLoading]);

  // Step 1: file picked → open cropper modal
  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoError("Please choose a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setPhotoError("Image must be 8MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setEditor({ dataUrl: String(reader.result), mime: file.type });
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      setPhotoError("");
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Step 2: confirm → canvas crop → upload
  async function confirmAndUpload() {
    if (!editor || !croppedAreaPixels) return;
    setPhotoState("loading");
    setPhotoError("");
    try {
      const blob = await getCroppedBlob(editor.dataUrl, croppedAreaPixels, 512, editor.mime);
      const fd = new FormData();
      fd.append("file", new File([blob], "avatar.jpg", { type: blob.type }));
      const res = await apiUpload<any>("/auth/me/profile-picture", fd);
      const updated = res.data;
      try {
        const stored = JSON.parse(localStorage.getItem("user") ?? "null");
        if (stored && typeof stored === "object") {
          stored.profileImageUrl = updated.profileImageUrl;
          localStorage.setItem("user", JSON.stringify(stored));
        }
      } catch {}
      setPreviewUrl(updated.profileImageUrl);
      setEditor(null);
      setPhotoState("success");
      setTimeout(() => setPhotoState("idle"), 2500);
    } catch (err: any) {
      setPhotoError(err?.message || "Failed to upload photo.");
      setPhotoState("error");
    }
  }

  // Remove profile picture (called after the in-page confirmation)
  async function handleRemovePhoto() {
    setPhotoState("loading");
    setPhotoError("");
    try {
      await apiFetch("/auth/me/profile-picture", { method: "DELETE" });
      try {
        const stored = JSON.parse(localStorage.getItem("user") ?? "null");
        if (stored && typeof stored === "object") {
          stored.profileImageUrl = null;
          localStorage.setItem("user", JSON.stringify(stored));
        }
      } catch {}
      setPreviewUrl(null);
      setLightboxOpen(false);
      setConfirmRemove(false);
      setPhotoState("success");
      setTimeout(() => setPhotoState("idle"), 2500);
    } catch (err: any) {
      setPhotoError(err?.message || "Failed to remove photo.");
      setPhotoState("error");
      setConfirmRemove(false);
    }
  }

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
      await apiFetch<any>("/auth/me", {
        method: "PUT",
        body: JSON.stringify({ name: profileForm.name.trim() }),
      });
      setSavedName(profileForm.name.trim());
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
    if (pwForm.next.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    if (pwForm.next !== pwForm.confirm) { setPwError("New passwords do not match."); return; }
    setPwState("loading");
    try {
      await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next }),
      });
      setPwState("success");
      setPwForm({ current: "", next: "", confirm: "" });
      setTimeout(() => setPwState("idle"), 3000);
    } catch (err: any) {
      setPwError(err?.message || "Failed to change password.");
      setPwState("error");
    }
  }

  // Client-side strength hint (visual only — validation rules are unchanged).
  const nx = pwForm.next;
  const score =
    (nx.length >= 8 ? 1 : 0) +
    (/[A-Z]/.test(nx) && /[a-z]/.test(nx) ? 1 : 0) +
    (/\d/.test(nx) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(nx) ? 1 : 0);
  const [strengthLabel, strengthColor] = ([["", "var(--hx-4A6275)"], ["Weak", "var(--hx-FB7185)"], ["Fair", "var(--hx-E9BD62)"], ["Good", "var(--hx-6EB2FF)"], ["Strong", "var(--hx-00D7A0)"]] as const)[nx ? Math.max(1, score) : 0];
  const strengthPct = nx ? Math.max(1, score) * 25 : 0;

  const displayName = savedName ?? user?.name ?? "";
  const avatarInitials = displayName ? displayName.trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase() : "—";
  const roles: string[] = user?.roles ?? [];
  const openPicker = () => fileInputRef.current?.click();

  const pwFields = [
    { label: "Current password", key: "current" as const, show: showCurrent, toggle: () => setShowCurrent((v) => !v), auto: "current-password" },
    { label: "New password", key: "next" as const, show: showNext, toggle: () => setShowNext((v) => !v), auto: "new-password" },
    { label: "Confirm new password", key: "confirm" as const, show: showConfirm, toggle: () => setShowConfirm((v) => !v), auto: "new-password" },
  ];

  return (
    <div className="pb-9">
      {/* Header */}
      <section className="pt-[30px] pb-[22px] max-w-[1040px]">
        <div className="text-[11px] font-bold tracking-[.2em] uppercase text-ds-gold">Account</div>
        <h1 className="mt-1.5 text-[34px] sm:text-[38px] font-extrabold tracking-[-.035em] text-ds-text leading-tight">Settings</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Manage your account preferences.</p>
      </section>

      <div className="max-w-[1040px] flex flex-col gap-[18px]">
        {/* Identity / photo card */}
        <section className={`${CARD} p-5 sm:p-[30px] bg-[radial-gradient(120%_160%_at_0%_0%,rgba(233,189,98,.12),rgba(233,189,98,.02)_50%,var(--hx-08131C)_100%)]`}>
          <span aria-hidden="true" className={TOP_LINE} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFilePicked}
          />
          <div className="flex items-center gap-7 flex-wrap">
            <div className="relative shrink-0">
              {previewUrl ? (
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  title="Click to preview"
                  aria-label="Preview profile photo"
                  disabled={isPhotoLoading}
                  className="block h-28 w-28 rounded-[28px] border-2 border-[rgba(233,189,98,.5)] overflow-hidden shadow-[0_14px_30px_rgba(0,0,0,.45)] p-0"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imgSrc(previewUrl)} alt="Profile" className="h-full w-full object-cover" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={openPicker}
                  title="Upload photo"
                  aria-label="Upload profile photo"
                  disabled={isPhotoLoading}
                  className="h-28 w-28 rounded-[28px] border-2 border-[rgba(233,189,98,.5)] bg-[linear-gradient(135deg,var(--hx-F4D58C),var(--hx-E9BD62))] text-[color:var(--hx-060D14)] grid place-items-center text-[38px] font-extrabold tracking-[-.03em] shadow-[0_14px_30px_rgba(0,0,0,.45)]"
                >
                  {avatarInitials}
                </button>
              )}
              <button
                type="button"
                onClick={openPicker}
                disabled={isPhotoLoading}
                title="Change photo"
                aria-label="Change photo"
                className="absolute -right-1.5 -bottom-1.5 h-[38px] w-[38px] rounded-full border-[3px] border-ds-card bg-ds-gold text-[color:var(--hx-060D14)] grid place-items-center hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-50"
              >
                <Icon d={IC.camera} className="h-[15px] w-[15px]" sw={2} />
              </button>
            </div>

            <div className="flex-[1_1_300px] min-w-0 flex flex-col gap-3">
              <div>
                <div className="text-[24px] sm:text-[28px] font-extrabold tracking-[-.03em] leading-[1.1] text-ds-text break-words">{displayName || "—"}</div>
                <div className="mt-[7px] flex items-center gap-2 text-[13.5px] text-ds-t2 min-w-0">
                  <Icon d={IC.mail} className="h-3.5 w-3.5" />
                  <span className="truncate" title={user?.email ?? undefined}>{user?.email ?? "—"}</span>
                </div>
                {roles.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {roles.map((r) => (
                      <span key={r} className="inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-full bg-[rgba(233,189,98,.12)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[11.5px] font-bold tracking-[.04em]">
                        <Icon d={IC.shield} className="h-3 w-3" sw={2} />{r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <button type="button" onClick={openPicker} disabled={isPhotoLoading} className={`${GOLD_BTN} h-10 px-[18px] text-[13px]`}>
                  <Icon d={IC.camera} className="h-3.5 w-3.5" sw={2} />
                  {previewUrl ? "Change photo" : "Upload photo"}
                </button>
                {previewUrl && (
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    disabled={isPhotoLoading}
                    className="inline-flex items-center gap-[7px] h-10 px-4 rounded-full border border-[rgba(229,72,77,.4)] text-[color:var(--hx-FB7185)] text-[13px] font-semibold hover:bg-[rgba(229,72,77,.1)] disabled:opacity-50"
                  >
                    <Icon d={IC.trash} className="h-[13px] w-[13px]" /> Remove
                  </button>
                )}
                <span className="text-[12px] text-ds-t3">JPG, PNG or WebP · crop and zoom before uploading</span>
              </div>
              {photoError && !editor && <Msg kind="err">{photoError}</Msg>}
              {photoState === "success" && <Msg kind="ok">Photo updated. Refresh other pages to see it everywhere.</Msg>}
            </div>
          </div>
        </section>

        {/* Profile details */}
        <form onSubmit={handleUpdateProfile} className={`${CARD} px-5 py-6 sm:px-[30px] sm:py-7`}>
          <span aria-hidden="true" className={TOP_LINE} />
          <div className="flex items-center gap-3.5 mb-[22px]">
            <span className="h-[42px] w-[42px] rounded-[12px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold grid place-items-center shrink-0">
              <Icon d={IC.user} className="h-[18px] w-[18px]" sw={1.8} />
            </span>
            <div>
              <div className="text-[18px] font-extrabold tracking-[-.02em] text-ds-text">Profile details</div>
              <div className="mt-[3px] text-[12.5px] text-ds-t3">Your name as it appears across the portal.</div>
            </div>
          </div>
          <div className="grid gap-5 items-start [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
            <div className="min-w-0">
              <label htmlFor="settings-name" className={LABEL}>Name</label>
              <input
                id="settings-name"
                type="text"
                value={profileForm.name}
                onChange={(e) => setProfileForm({ name: e.target.value })}
                required
                autoComplete="name"
                className={FIELD}
              />
            </div>
            <div className="min-w-0">
              <span className={LABEL}>Email</span>
              <div
                title={user?.email ?? undefined}
                className="w-full h-12 px-[18px] rounded-[14px] border border-dashed border-ds-line2 bg-[color:var(--hx-0A1620)] text-ds-t2 text-[14px] flex items-center gap-2.5 select-all"
              >
                <span className="flex-1 min-w-0 truncate">{user?.email ?? "—"}</span>
                <span className="text-ds-t3 flex"><Icon d={IC.lock} className="h-3.5 w-3.5" /></span>
              </div>
              <p className="mt-2 text-[11.5px] leading-[1.5] text-ds-t3">Your email is your sign-in and can&apos;t be changed here. Ask an admin if it needs updating.</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-[22px] pt-5 border-t border-[color:var(--hx-1A2C38)]">
            <div>
              {profileError && <Msg kind="err">{profileError}</Msg>}
              {profileState === "success" && <Msg kind="ok">Profile updated.</Msg>}
            </div>
            <button type="submit" disabled={profileState === "loading"} className={`${GOLD_BTN} ml-auto h-11 px-6 text-[13.5px]`}>
              {profileState === "loading" ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>

        {/* Change password */}
        <form onSubmit={handleChangePassword} className={`${CARD} px-5 py-6 sm:px-[30px] sm:py-7`}>
          <span aria-hidden="true" className={TOP_LINE} />
          <div className="flex items-center gap-3.5 mb-[22px]">
            <span className="h-[42px] w-[42px] rounded-[12px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold grid place-items-center shrink-0">
              <Icon d={IC.lock} className="h-[18px] w-[18px]" sw={1.8} />
            </span>
            <div>
              <div className="text-[18px] font-extrabold tracking-[-.02em] text-ds-text">Change password</div>
              <div className="mt-[3px] text-[12.5px] text-ds-t3">Use at least 8 characters.</div>
            </div>
          </div>
          <div className="grid gap-5 items-start [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
            {pwFields.map(({ label, key, show, toggle, auto }) => (
              <div key={key} className="min-w-0">
                <label htmlFor={`pw-${key}`} className={LABEL}>{label}</label>
                <div className="relative">
                  <input
                    id={`pw-${key}`}
                    type={show ? "text" : "password"}
                    value={pwForm[key]}
                    onChange={(e) => setPwForm((f) => ({ ...f, [key]: e.target.value }))}
                    required
                    autoComplete={auto}
                    className={`${FIELD} pr-12`}
                  />
                  <button
                    type="button"
                    onClick={toggle}
                    title={show ? "Hide password" : "Show password"}
                    aria-label={show ? "Hide password" : "Show password"}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-[34px] w-[34px] rounded-[10px] text-ds-t3 grid place-items-center hover:text-ds-text"
                  >
                    <Icon d={show ? IC.eyeOff : IC.eye} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 flex items-center gap-2.5">
            <div className="flex-1 max-w-[260px] h-[5px] rounded-[3px] bg-[color:var(--hx-132430)] overflow-hidden">
              <div className="h-full rounded-[3px] transition-[width] duration-200" style={{ width: `${strengthPct}%`, background: strengthColor }} />
            </div>
            <span className="text-[11.5px] font-semibold" style={{ color: strengthColor }}>{strengthLabel}</span>
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-[22px] pt-5 border-t border-[color:var(--hx-1A2C38)]">
            <div>
              {pwError && <Msg kind="err">{pwError}</Msg>}
              {pwState === "success" && <Msg kind="ok">Password changed successfully.</Msg>}
            </div>
            <button type="submit" disabled={pwState === "loading"} className={`${GOLD_BTN} ml-auto h-11 px-6 text-[13.5px]`}>
              {pwState === "loading" ? "Saving…" : "Update password"}
            </button>
          </div>
        </form>
      </div>

      {/* ── Lightbox: click avatar to view full-size ── */}
      {lightboxOpen && previewUrl && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-[300] bg-[rgba(2,6,10,.88)] flex items-center justify-center p-6" onClick={() => setLightboxOpen(false)}>
              <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Profile photo preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imgSrc(previewUrl)} alt="Profile preview" className="max-h-[76vh] max-w-[90vw] rounded-[22px] shadow-[0_30px_80px_rgba(0,0,0,.6)] object-contain" />
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => { setLightboxOpen(false); openPicker(); }}
                    disabled={isPhotoLoading}
                    className="inline-flex items-center gap-[7px] h-[38px] px-4 rounded-full border border-[rgba(255,255,255,.2)] bg-[rgba(255,255,255,.08)] text-white text-[13px] font-semibold hover:bg-[rgba(255,255,255,.14)] disabled:opacity-50"
                  >
                    <Icon d={IC.camera} className="h-[13px] w-[13px]" /> Change
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    disabled={isPhotoLoading}
                    className="inline-flex items-center gap-[7px] h-[38px] px-4 rounded-full bg-[color:var(--hx-E5484D)] text-white text-[13px] font-semibold disabled:opacity-50"
                  >
                    <Icon d={IC.trash} className="h-[13px] w-[13px]" /> {isPhotoLoading ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLightboxOpen(false)}
                aria-label="Close preview"
                className="absolute top-5 right-5 h-[38px] w-[38px] rounded-full bg-[rgba(255,255,255,.1)] text-white grid place-items-center hover:bg-[rgba(255,255,255,.18)]"
              >
                <Icon d={IC.close} className="h-[17px] w-[17px]" sw={2} />
              </button>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ── Crop modal ── */}
      {editor && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-[300] bg-[rgba(2,6,10,.85)] flex items-center justify-center p-4">
              <div
                className="w-full max-w-[380px] bg-ds-card border border-ds-line2 rounded-[18px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,.6)] text-ds-text"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Crop photo"
              >
                <div className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--hx-1A2C38)]">
                  <span className="flex items-center gap-2 text-[14px] font-bold">
                    <span className="text-ds-gold flex"><Icon d={IC.camera} className="h-[15px] w-[15px]" /></span>Crop Photo
                  </span>
                  <button
                    type="button"
                    onClick={() => !isPhotoLoading && setEditor(null)}
                    disabled={isPhotoLoading}
                    aria-label="Close"
                    className="h-[30px] w-[30px] rounded-[8px] text-ds-t3 grid place-items-center hover:text-ds-text disabled:opacity-50"
                  >
                    <Icon d={IC.close} className="h-[15px] w-[15px]" sw={2} />
                  </button>
                </div>

                <div className="relative w-full bg-black h-[320px]">
                  <Cropper
                    image={editor.dataUrl}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={onCropComplete}
                    showGrid
                    style={{
                      containerStyle: { borderRadius: 0 },
                      cropAreaStyle: {
                        border: "2px solid var(--hx-FFFFFF)",
                        boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                      },
                    }}
                  />
                </div>

                <div className="px-5 pt-4 pb-1">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10.5px] font-bold tracking-[.14em] uppercase text-ds-t3">Zoom</span>
                    <span className="text-[11.5px] text-ds-t2 tabular-nums">{zoom.toFixed(1)}×</span>
                  </div>
                  <input
                    type="range" min="1" max="3" step="0.05" value={zoom}
                    onChange={(e) => setZoom(parseFloat(e.target.value))}
                    aria-label="Zoom"
                    className="w-full accent-[color:var(--hx-E9BD62)]"
                    disabled={isPhotoLoading}
                  />
                </div>

                {photoError && (
                  <div className="mx-5 mt-2"><Msg kind="err">{photoError}</Msg></div>
                )}

                <div className="flex items-center gap-2 justify-end px-5 pb-5 pt-3">
                  <button
                    type="button"
                    onClick={() => setEditor(null)}
                    disabled={isPhotoLoading}
                    className="h-10 px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmAndUpload}
                    disabled={isPhotoLoading || !croppedAreaPixels}
                    className={`${GOLD_BTN} h-10 px-[18px] text-[13px]`}
                  >
                    <Icon d={IC.check} className="h-3.5 w-3.5" sw={2.2} />
                    {isPhotoLoading ? "Uploading…" : "Save Photo"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* ── Remove-photo confirmation ── */}
      {confirmRemove && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-[310] bg-[rgba(2,6,10,.72)] flex items-center justify-center p-4" onClick={() => !isPhotoLoading && setConfirmRemove(false)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
                aria-label="Remove your profile picture?"
                className="w-full max-w-[360px] bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] text-ds-text"
              >
                <div className="h-10 w-10 rounded-[11px] bg-[rgba(229,72,77,.12)] text-[color:var(--hx-FB7185)] grid place-items-center">
                  <Icon d={IC.trash} className="h-[17px] w-[17px]" />
                </div>
                <div className="mt-3.5 text-[15px] font-semibold">Remove your profile picture?</div>
                <div className="flex justify-end gap-2 mt-[22px]">
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    disabled={isPhotoLoading}
                    className="h-[38px] px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRemovePhoto}
                    disabled={isPhotoLoading}
                    className="h-[38px] px-[18px] rounded-full bg-[color:var(--hx-E5484D)] text-white text-[13px] font-bold disabled:opacity-60"
                  >
                    {isPhotoLoading ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
