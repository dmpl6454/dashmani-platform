"use client";

import { useState, useRef, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { apiFetch, apiUpload, API_BASE } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { User, Lock, AlertCircle, Check, Eye, EyeOff, Camera, ZoomIn, Trash2, X, Clock } from "lucide-react";
import { UserAvatar } from "@/components/user-avatar";
import Cropper from "react-easy-crop";

const inputCls =
  "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors";

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

export default function SettingsPage() {
  usePageTitle("Settings");
  const { user } = useAuth();

  const [profileForm, setProfileForm] = useState({ name: user?.name ?? "" });
  const [profileState, setProfileState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [profileError, setProfileError] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [photoState, setPhotoState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [photoError, setPhotoError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(user?.profileImageUrl ?? null);

  // Lightbox — click avatar to preview full-size
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Cropper state
  const [editor, setEditor] = useState<{ dataUrl: string; mime: string } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setCroppedAreaPixels(pixels);
  }, []);

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

  // Remove profile picture
  async function handleRemovePhoto() {
    if (!window.confirm("Remove your profile picture?")) return;
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
      setPhotoState("success");
      setTimeout(() => setPhotoState("idle"), 2500);
    } catch (err: any) {
      setPhotoError(err?.message || "Failed to remove photo.");
      setPhotoState("error");
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

  const isPhotoLoading = photoState === "loading";

  return (
    <>
    <div className="space-y-8 crx-animate-fade max-w-2xl">
      <div>
        <h1 className="font-serif text-4xl font-light text-ink">Settings</h1>
        <p className="text-sm text-ink-3 mt-1">Manage your account preferences.</p>
      </div>

      {/* Profile photo card */}
      <div className="v3-card p-6 space-y-4">
        <h2 className="font-semibold text-ink flex items-center gap-2 text-base">
          <Camera size={16} className="text-ink-4" /> Profile Photo
        </h2>
        <div className="flex items-center gap-5">
          <div className="relative shrink-0">
            {previewUrl ? (
              <button
                type="button"
                onClick={() => setLightboxOpen(true)}
                title="Click to preview"
                className="block relative group"
                disabled={isPhotoLoading}
              >
                <img
                  src={previewUrl.startsWith("http") ? previewUrl : `${API_BASE}${previewUrl}`}
                  alt="Profile"
                  className="h-20 w-20 rounded-2xl object-cover ring-2 ring-white shadow-md"
                />
                <span className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/30 transition-colors grid place-items-center">
                  <ZoomIn size={18} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </span>
              </button>
            ) : (
              <UserAvatar name={user?.name} imageUrl={null} size={20} textClassName="text-2xl" />
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPhotoLoading}
              title="Change photo"
              className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-ink text-white grid place-items-center hover:bg-ink/80 transition-colors disabled:opacity-50 shadow-sm"
            >
              <Camera size={13} />
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleFilePicked}
            />
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPhotoLoading}
                className="bg-ink text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                <Camera size={14} />
                {previewUrl ? "Change photo" : "Upload photo"}
              </button>
              {previewUrl && (
                <button
                  type="button"
                  onClick={handleRemovePhoto}
                  disabled={isPhotoLoading}
                  className="px-4 py-2 rounded-full text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-50 transition-colors flex items-center gap-1.5 border border-danger/20"
                >
                  <Trash2 size={13} /> Remove
                </button>
              )}
            </div>
            <p className="text-xs text-ink-4">JPG, PNG, or WebP. Crop and zoom before uploading.</p>
            {photoError && (
              <div className="flex items-center gap-2 text-danger text-xs font-medium">
                <AlertCircle size={12} /> {photoError}
              </div>
            )}
            {photoState === "success" && (
              <div className="flex items-center gap-2 text-success text-xs font-medium">
                <Check size={12} /> Photo updated. Refresh other pages to see it everywhere.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Profile card */}
      <div className="v3-card p-6 space-y-4">
        <h2 className="font-semibold text-ink flex items-center gap-2 text-base">
          <User size={16} className="text-ink-4" /> Profile
        </h2>
        <form onSubmit={handleUpdateProfile} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Name</label>
              <input type="text" value={profileForm.name} onChange={(e) => setProfileForm({ name: e.target.value })}
                required autoComplete="name" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Email</label>
              <p className="w-full border-2 border-ink/10 bg-surface/60 rounded-xl px-4 py-2.5 text-sm text-ink-3 select-all truncate" title={user?.email ?? undefined}>
                {user?.email ?? "—"}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Roles</label>
              <p className="text-ink font-semibold text-sm">{user?.roles?.join(", ") ?? "—"}</p>
            </div>
          </div>
          {profileError && <div className="flex items-center gap-2 text-danger text-sm font-medium"><AlertCircle size={14} /> {profileError}</div>}
          {profileState === "success" && <div className="flex items-center gap-2 text-success text-sm font-medium"><Check size={14} /> Profile updated.</div>}
          <button type="submit" disabled={profileState === "loading"}
            className="bg-ink text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors">
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
          {[
            { label: "Current password", key: "current" as const, show: showCurrent, toggle: () => setShowCurrent(v => !v), auto: "current-password" },
            { label: "New password",     key: "next"    as const, show: showNext,    toggle: () => setShowNext(v => !v),    auto: "new-password" },
            { label: "Confirm new password", key: "confirm" as const, show: showConfirm, toggle: () => setShowConfirm(v => !v), auto: "new-password" },
          ].map(({ label, key, show, toggle, auto }) => (
            <div key={key}>
              <label className="block text-xs font-medium text-ink-3 mb-1">{label}</label>
              <div className="relative">
                <input type={show ? "text" : "password"} value={pwForm[key]}
                  onChange={(e) => setPwForm((f) => ({ ...f, [key]: e.target.value }))}
                  required autoComplete={auto} className={inputCls + " pr-10"} />
                <button type="button" onClick={toggle}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink">
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          ))}
          {pwError && <div className="flex items-center gap-2 text-danger text-sm font-medium"><AlertCircle size={14} /> {pwError}</div>}
          {pwState === "success" && <div className="flex items-center gap-2 text-success text-sm font-medium"><Check size={14} /> Password changed successfully.</div>}
          <button type="submit" disabled={pwState === "loading"}
            className="bg-ink text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors">
            {pwState === "loading" ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>
    </div>

    {/* ── Lightbox: click avatar to view full-size ── */}
    {lightboxOpen && previewUrl && (
      <div className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center p-6"
        onClick={() => setLightboxOpen(false)}>
        <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
          <img
            src={previewUrl.startsWith("http") ? previewUrl : `${API_BASE}${previewUrl}`}
            alt="Profile preview"
            className="max-h-[80vh] max-w-[90vw] rounded-2xl shadow-2xl object-contain"
          />
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { setLightboxOpen(false); fileInputRef.current?.click(); }}
              disabled={isPhotoLoading}
              className="h-9 px-4 rounded-full bg-white/15 hover:bg-white/25 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <Camera size={13} /> Change
            </button>
            <button type="button" onClick={handleRemovePhoto} disabled={isPhotoLoading}
              className="h-9 px-4 rounded-full bg-red-500/90 hover:bg-red-500 text-white text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <Trash2 size={13} /> {isPhotoLoading ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
        <button type="button" onClick={() => setLightboxOpen(false)}
          className="absolute top-5 right-5 h-9 w-9 rounded-full bg-white/15 hover:bg-white/25 text-white grid place-items-center"
          aria-label="Close preview">
          <X size={18} />
        </button>
      </div>
    )}

    {/* ── Crop modal with border handles ── */}
    {editor && (
      <div className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
          onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-ink/8">
            <h3 className="font-semibold text-ink flex items-center gap-2 text-sm">
              <Camera size={15} className="text-indigo" /> Crop Photo
            </h3>
            <button type="button" onClick={() => !isPhotoLoading && setEditor(null)} disabled={isPhotoLoading}
              className="h-8 w-8 rounded-lg text-ink-3 hover:text-ink hover:bg-ink/5 grid place-items-center disabled:opacity-50">
              <X size={16} />
            </button>
          </div>

          {/* Cropper canvas — square, fixed height */}
          <div className="relative w-full bg-black" style={{ height: 320 }}>
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
                  border: "2px solid #ffffff",
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                },
              }}
            />
          </div>

          {/* Zoom slider */}
          <div className="px-5 pt-4 pb-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Zoom</span>
              <span className="text-[11px] text-ink-3 tabular-nums">{zoom.toFixed(1)}×</span>
            </div>
            <input type="range" min="1" max="3" step="0.05" value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="w-full accent-ink" disabled={isPhotoLoading} />
          </div>

          {photoError && (
            <div className="mx-5 mb-2 flex items-center gap-2 text-danger text-xs font-medium">
              <AlertCircle size={12} /> {photoError}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 justify-end px-5 pb-5 pt-2">
            <button type="button" onClick={() => setEditor(null)} disabled={isPhotoLoading}
              className="px-4 py-2 rounded-full text-sm font-semibold text-ink hover:bg-ink/5 disabled:opacity-50 transition-colors">
              Cancel
            </button>
            <button type="button" onClick={confirmAndUpload} disabled={isPhotoLoading || !croppedAreaPixels}
              className="px-5 py-2 rounded-full bg-ink text-white text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors flex items-center gap-1.5">
              {isPhotoLoading
                ? <><Clock size={13} /> Uploading…</>
                : <><Check size={13} /> Save Photo</>}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
