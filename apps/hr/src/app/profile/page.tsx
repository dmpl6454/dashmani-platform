"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, apiUpload, API_BASE } from "@/lib/api";
import { Save, User, Building2, CreditCard, Users, FileText, Camera, Check, Clock, Upload, Lock, Eye, EyeOff, Pencil, X, ZoomIn, Trash2 } from "lucide-react";
import Cropper from "react-easy-crop";
import Link from "next/link";
import { Topstrip } from "@/components/portal-shell";
import { maskPII } from "@/lib/utils/mask";
import { formatStatus } from "@dashmani/shared";

interface ProfileData {
  id: string; userId: string; name: string; email: string; phone?: string | null;
  profileImageUrl?: string | null; status: string; designation?: string | null; salary?: number | null;
  bankAccountHolderName?: string | null; bankAccountNumber?: string | null; bankName?: string | null;
  bankBranch?: string | null; ifscCode?: string | null; mailingAddress?: string | null;
  aadhaarNumber?: string | null; panNumber?: string | null;
  familyContact1Name?: string | null; familyContact1Phone?: string | null; familyContact1Relation?: string | null;
  familyContact2Name?: string | null; familyContact2Phone?: string | null; familyContact2Relation?: string | null;
}

const fieldCls = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";
const selectCls = fieldCls + " appearance-none pr-8";
const RELATIONS = ["Father","Mother","Spouse","Brother","Sister","Son","Daughter","Other"];

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  const [uploadingPic, setUploadingPic] = useState(false); const [picSuccess, setPicSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Preview lightbox (click current avatar to view large)
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Pre-upload cropper modal
  const [editor, setEditor] = useState<{ dataUrl: string; mime: string } | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const onCropComplete = useCallback((_: any, pixels: any) => {
    setCroppedAreaPixels(pixels);
  }, []);

  const [form, setForm] = useState({
    bankAccountHolderName: "", bankAccountNumber: "", bankName: "", bankBranch: "", ifscCode: "",
    mailingAddress: "", aadhaarNumber: "", panNumber: "",
    familyContact1Name: "", familyContact1Phone: "", familyContact1Relation: "",
    familyContact2Name: "", familyContact2Phone: "", familyContact2Relation: "",
  });

  // PII masking: each sensitive field has its own editing state
  const [editingPII, setEditingPII] = useState({
    bankAccountNumber: false,
    ifscCode: false,
    aadhaarNumber: false,
    panNumber: false,
  });

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    try {
      const res: any = await apiFetch("/hr/profile"); const p = res.data;
      setProfile(p);
      setForm({
        bankAccountHolderName: p.bankAccountHolderName || "", bankAccountNumber: p.bankAccountNumber || "",
        bankName: p.bankName || "", bankBranch: p.bankBranch || "", ifscCode: p.ifscCode || "",
        mailingAddress: p.mailingAddress || "", aadhaarNumber: p.aadhaarNumber || "", panNumber: p.panNumber || "",
        familyContact1Name: p.familyContact1Name || "", familyContact1Phone: p.familyContact1Phone || "", familyContact1Relation: p.familyContact1Relation || "",
        familyContact2Name: p.familyContact2Name || "", familyContact2Phone: p.familyContact2Phone || "", familyContact2Relation: p.familyContact2Relation || "",
      });
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  // Step 1: file picked → open cropper modal
  function handleProfilePicPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please select a JPG, PNG or WebP image."); return; }
    if (file.size > 8 * 1024 * 1024) { setError("Image must be 8MB or smaller before resize."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setEditor({ dataUrl: String(reader.result), mime: file.type });
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
    };
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Step 2: user confirms → canvas crop → upload
  async function confirmAndUpload() {
    if (!editor || !croppedAreaPixels) return;
    setUploadingPic(true); setPicSuccess(""); setError("");
    try {
      const blob = await getCroppedBlob(editor.dataUrl, croppedAreaPixels, 512, editor.mime);
      const fd = new FormData();
      fd.append("file", new File([blob], "avatar.jpg", { type: blob.type }));
      const res: any = await apiUpload("/hr/profile-picture", fd);
      const newUrl = res?.data?.profileImageUrl ?? null;
      setProfile((p: any) => p ? { ...p, profileImageUrl: newUrl } : p);
      setPicSuccess("Profile picture updated!");
      setEditor(null);
      setTimeout(() => setPicSuccess(""), 3500);
    } catch (err: any) { setError(err.message || "Failed to upload."); }
    finally { setUploadingPic(false); }
  }

  // Remove current profile picture (revert to placeholder)
  async function handleRemovePic() {
    if (!confirm("Remove your profile picture?")) return;
    setUploadingPic(true); setPicSuccess(""); setError("");
    try {
      const res: any = await apiFetch("/hr/profile-picture", { method: "DELETE" });
      setProfile((p: any) => p ? { ...p, profileImageUrl: res?.data?.profileImageUrl ?? null } : p);
      setLightboxOpen(false);
      setPicSuccess("Profile picture removed.");
      setTimeout(() => setPicSuccess(""), 3500);
    } catch (err: any) { setError(err.message || "Failed to remove."); }
    finally { setUploadingPic(false); }
  }

  // Canvas crop from the pixel area returned by react-easy-crop
  function getCroppedBlob(dataUrl: string, pixelCrop: { x: number; y: number; width: number; height: number }, size: number, mime: string): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unsupported"));
        ctx.drawImage(img, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height, 0, 0, size, size);
        const outMime = mime === "image/png" ? "image/png" : "image/jpeg";
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob failed")), outMime, 0.9);
      };
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = dataUrl;
    });
  }

  function upd(field: string, value: string) { setForm(prev => ({ ...prev, [field]: value })); }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault(); setError(""); setSuccess(""); setSaving(true);
    try {
      const res: any = await apiFetch("/hr/profile", { method: "PUT", body: JSON.stringify(form) });
      setProfile(res.data); setSuccess("Profile updated!");
      setEditingPII({ bankAccountNumber: false, ifscCode: false, aadhaarNumber: false, panNumber: false });
      setTimeout(() => setSuccess(""), 3000);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo" /></div>;

  const statusCls = profile?.status === "ACTIVE" ? "bg-success-bg text-success" : profile?.status === "ONBOARDING" ? "bg-action-soft text-ink-2" : "bg-danger-bg text-danger";

  return (
    <>
      <Topstrip title="My Profile" sub="Update your personal and banking details" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <form onSubmit={handleSave} className="space-y-4 anim-fade-up d1">

          {/* Basic Info */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <User size={15} className="text-indigo" />
              <h3 className="text-[14px] font-bold text-ink">Basic Information</h3>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-5 mb-5">
                <div className="relative">
                  {profile?.profileImageUrl ? (
                    <button
                      type="button"
                      onClick={() => setLightboxOpen(true)}
                      title="Click to preview"
                      className="block relative group"
                    >
                      <img src={profile.profileImageUrl.startsWith("http") ? profile.profileImageUrl : `${API_BASE}${profile.profileImageUrl}`} alt="Profile"
                        className="h-16 w-16 rounded-2xl object-cover" style={{ border: "2px solid rgba(26,26,26,0.12)" }} />
                      <span className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/30 transition-colors grid place-items-center">
                        <ZoomIn size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </span>
                    </button>
                  ) : (
                    <div className="h-16 w-16 rounded-2xl bg-indigo-soft grid place-items-center" style={{ border: "2px solid rgba(26,26,26,0.12)" }}>
                      <User size={20} className="text-indigo" />
                    </div>
                  )}
                  <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingPic}
                    className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-ink text-white grid place-items-center hover:bg-ink-2 transition-colors">
                    <Camera size={12} />
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleProfilePicPicked} className="hidden" />
                </div>
                <div>
                  <h2 className="font-display text-[22px] font-semibold text-ink">{profile?.name}</h2>
                  <p className="text-[13px] text-ink-3 font-medium mt-0.5">{profile?.designation || "Employee"}</p>
                  <div className="flex gap-2 mt-2">
                    <span className={`h-6 px-2.5 rounded-full text-[10.5px] font-semibold inline-flex items-center ${statusCls}`}>{profile?.status ? formatStatus(profile.status) : ""}</span>
                  </div>
                </div>
                {uploadingPic && <span className="text-[12px] text-ink-3 flex items-center gap-1 ml-2"><Clock size={12} /> Uploading…</span>}
                {picSuccess && <span className="text-[12px] text-success flex items-center gap-1 ml-2"><Check size={12} strokeWidth={2.5} /> {picSuccess}</span>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[["Name",        profile?.name ?? ""],["Email",      profile?.email ?? ""],["Phone",       profile?.phone ?? "Not set"],["Designation", profile?.designation ?? "Assigned by admin"]].map(([label, val]) => (
                  <div key={label}>
                    <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">{label}</label>
                    <div className="h-10 px-3 flex items-center text-[13px] font-medium text-ink-2 rounded-xl bg-muted/50 border-2 border-ink/5">{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Bank Details */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <CreditCard size={15} className="text-indigo" />
              <h3 className="text-[14px] font-bold text-ink">Bank Account Details</h3>
            </div>
            <div className="p-5 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Account Holder Name</label>
                <input type="text" value={form.bankAccountHolderName} onChange={e => upd("bankAccountHolderName", e.target.value)} placeholder="Full name as per bank" className={fieldCls} />
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Account Number</label>
                {editingPII.bankAccountNumber || !form.bankAccountNumber ? (
                  <input type="text" value={form.bankAccountNumber} onChange={e => upd("bankAccountNumber", e.target.value)} placeholder="Account number" className={fieldCls} />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={fieldCls + " flex items-center text-ink-3 tracking-widest"}>{maskPII(form.bankAccountNumber)}</span>
                    <button type="button" onClick={() => setEditingPII(s => ({ ...s, bankAccountNumber: true }))} className="flex items-center gap-1 text-[12px] text-indigo font-semibold hover:underline shrink-0"><Pencil size={12} /> Edit</button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">IFSC Code</label>
                {editingPII.ifscCode || !form.ifscCode ? (
                  <input type="text" value={form.ifscCode} onChange={e => upd("ifscCode", e.target.value.toUpperCase())} placeholder="e.g. SBIN0001234" className={fieldCls} />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={fieldCls + " flex items-center text-ink-3 tracking-widest"}>{maskPII(form.ifscCode)}</span>
                    <button type="button" onClick={() => setEditingPII(s => ({ ...s, ifscCode: true }))} className="flex items-center gap-1 text-[12px] text-indigo font-semibold hover:underline shrink-0"><Pencil size={12} /> Edit</button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Bank Name</label>
                <input type="text" value={form.bankName} onChange={e => upd("bankName", e.target.value)} placeholder="e.g. State Bank of India" className={fieldCls} />
              </div>
              <div className="col-span-2">
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Branch Name</label>
                <input type="text" value={form.bankBranch} onChange={e => upd("bankBranch", e.target.value)} placeholder="e.g. Connaught Place, New Delhi" className={fieldCls} />
              </div>
            </div>
          </div>

          {/* Mailing Address */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <Building2 size={15} className="text-indigo" />
              <h3 className="text-[14px] font-bold text-ink">Mailing Address</h3>
            </div>
            <div className="p-5">
              <textarea value={form.mailingAddress} onChange={e => upd("mailingAddress", e.target.value)} rows={3}
                className="w-full px-3 py-2.5 text-[13.5px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none resize-none placeholder:text-ink-4"
                placeholder="Full mailing address including PIN code…" />
            </div>
          </div>

          {/* ID Proof */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <div className="flex items-center gap-2"><FileText size={15} className="text-indigo" /><h3 className="text-[14px] font-bold text-ink">ID Proof</h3></div>
              <Link href="/documents" className="inline-flex items-center gap-1.5 h-7 px-3 rounded-lg bg-muted text-ink-3 text-[12px] font-semibold hover:bg-muted/80 transition-colors">
                <Upload size={12} /> Upload Documents
              </Link>
            </div>
            <div className="p-5 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Aadhaar Number</label>
                {editingPII.aadhaarNumber || !form.aadhaarNumber ? (
                  <input type="text" value={form.aadhaarNumber} onChange={e => upd("aadhaarNumber", e.target.value.replace(/\D/g,"").slice(0,12))} placeholder="12-digit Aadhaar" maxLength={12} className={fieldCls} />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={fieldCls + " flex items-center text-ink-3 tracking-widest"}>{maskPII(form.aadhaarNumber)}</span>
                    <button type="button" onClick={() => setEditingPII(s => ({ ...s, aadhaarNumber: true }))} className="flex items-center gap-1 text-[12px] text-indigo font-semibold hover:underline shrink-0"><Pencil size={12} /> Edit</button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">PAN Number</label>
                {editingPII.panNumber || !form.panNumber ? (
                  <input type="text" value={form.panNumber} onChange={e => upd("panNumber", e.target.value.toUpperCase().slice(0,10))} placeholder="e.g. ABCDE1234F" maxLength={10} className={fieldCls} />
                ) : (
                  <div className="flex items-center gap-2">
                    <span className={fieldCls + " flex items-center text-ink-3 tracking-widest"}>{maskPII(form.panNumber)}</span>
                    <button type="button" onClick={() => setEditingPII(s => ({ ...s, panNumber: true }))} className="flex items-center gap-1 text-[12px] text-indigo font-semibold hover:underline shrink-0"><Pencil size={12} /> Edit</button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Family Contacts */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <Users size={15} className="text-indigo" />
              <h3 className="text-[14px] font-bold text-ink">Emergency Contacts</h3>
            </div>
            <div className="p-5 space-y-5">
              {[1,2].map(n => {
                const prefix = `familyContact${n}` as const;
                const nameKey = `${prefix}Name` as keyof typeof form;
                const phoneKey = `${prefix}Phone` as keyof typeof form;
                const relKey = `${prefix}Relation` as keyof typeof form;
                return (
                  <div key={n}>
                    {n === 2 && <div className="my-1" style={{ borderTop: "1px dashed rgba(26,26,26,0.1)" }} />}
                    <p className="text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-3">Contact {n}</p>
                    <div className="grid grid-cols-3 gap-3">
                      <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Name</label><input type="text" value={form[nameKey]} onChange={e => upd(nameKey, e.target.value)} placeholder="Full name" className={fieldCls} /></div>
                      <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Phone</label><input type="tel" value={form[phoneKey]} onChange={e => upd(phoneKey, e.target.value)} placeholder="+91…" className={fieldCls} /></div>
                      <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Relation</label>
                        <select value={form[relKey]} onChange={e => upd(relKey, e.target.value)} className={selectCls}>
                          <option value="">Select…</option>
                          {RELATIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {error && <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 text-[12.5px] text-danger font-medium">{error}</div>}
          {success && <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2 text-[12.5px] text-success font-semibold"><Check size={13} strokeWidth={2.5} />{success}</div>}

          <button type="submit" disabled={saving}
            className="btn-3d inline-flex items-center gap-2 px-6 h-11 rounded-xl bg-ink text-white text-[13.5px] font-semibold border-2 border-ink disabled:opacity-50">
            <Save size={15} /> {saving ? "Saving…" : "Save Profile"}
          </button>
        </form>

        {/* Password Change */}
        <PasswordChangeSection />
      </div>

      {/* Lightbox preview — click current avatar to view large + actions */}
      {lightboxOpen && profile?.profileImageUrl && (
        <div
          className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center p-6"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="flex flex-col items-center gap-4" onClick={(e) => e.stopPropagation()}>
            <img
              src={profile.profileImageUrl.startsWith("http") ? profile.profileImageUrl : `${API_BASE}${profile.profileImageUrl}`}
              alt="Profile preview"
              className="max-h-[80vh] max-w-[90vw] rounded-2xl shadow-2xl object-contain"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setLightboxOpen(false); fileInputRef.current?.click(); }}
                disabled={uploadingPic}
                className="h-9 px-4 rounded-full bg-white/15 hover:bg-white/25 text-white text-[13px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                <Camera size={13} /> Change
              </button>
              <button
                type="button"
                onClick={handleRemovePic}
                disabled={uploadingPic}
                className="h-9 px-4 rounded-full bg-red-500/90 hover:bg-red-500 text-white text-[13px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                <Trash2 size={13} /> {uploadingPic ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            className="absolute top-5 right-5 h-9 w-9 rounded-full bg-white/15 hover:bg-white/25 text-white grid place-items-center"
            aria-label="Close preview"
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* Crop modal with draggable border handles */}
      {editor && (
        <div className="fixed inset-0 z-[300] bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-bg rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ border: "2px solid rgba(26,26,26,0.08)" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <h3 className="text-[14px] font-bold text-ink flex items-center gap-2">
                <Camera size={14} className="text-indigo" /> Crop Photo
              </h3>
              <button type="button" onClick={() => !uploadingPic && setEditor(null)} disabled={uploadingPic}
                className="h-8 w-8 rounded-lg text-ink-3 hover:text-ink hover:bg-muted/60 grid place-items-center disabled:opacity-50">
                <X size={16} />
              </button>
            </div>

            {/* Cropper canvas */}
            <div className="relative w-full bg-black" style={{ height: 300 }}>
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
                <span className="text-[11px] font-bold text-ink-3 uppercase tracking-wider">Zoom</span>
                <span className="text-[11px] text-ink-3 tabular-nums">{zoom.toFixed(1)}×</span>
              </div>
              <input type="range" min="1" max="3" step="0.05" value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="w-full" disabled={uploadingPic} />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 justify-end px-5 pb-5 pt-2">
              <button type="button" onClick={() => setEditor(null)} disabled={uploadingPic}
                className="h-9 px-4 rounded-full text-[13px] font-semibold text-ink hover:bg-muted/60 disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={confirmAndUpload} disabled={uploadingPic || !croppedAreaPixels}
                className="h-9 px-4 rounded-full bg-ink text-white text-[13px] font-semibold hover:bg-ink-2 disabled:opacity-50 flex items-center gap-1.5">
                {uploadingPic ? <><Clock size={13} /> Uploading…</> : <><Check size={13} /> Save Photo</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PasswordChangeSection() {
  const [currentPw, setCurrentPw] = useState(""); const [newPw, setNewPw] = useState(""); const [confirmPw, setConfirmPw] = useState("");
  const [showCurrent, setShowCurrent] = useState(false); const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState("");

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault(); setError(""); setSuccess("");
    if (!/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(newPw)) { setError("Password must be at least 8 characters with 1 uppercase, 1 number, and 1 special character"); return; }
    if (newPw !== confirmPw) { setError("Passwords do not match"); return; }
    setSaving(true);
    try {
      await apiFetch("/hr/change-password", { method: "POST", body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }) });
      setSuccess("Password changed!"); setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (err: any) { setError(err.message || "Failed to change password"); }
    finally { setSaving(false); }
  }

  const fieldCls2 = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";

  return (
    <div className="v3-card overflow-hidden mt-4 mb-8">
      <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
        <Lock size={15} className="text-indigo" />
        <h3 className="text-[14px] font-bold text-ink">Change Password</h3>
      </div>
      <form onSubmit={handleChangePassword} className="p-5 space-y-4 max-w-md">
        {[
          { label: "Current Password", value: currentPw, onChange: setCurrentPw, show: showCurrent, toggle: () => setShowCurrent(v => !v) },
          { label: "New Password",     value: newPw,     onChange: setNewPw,     show: showNew,     toggle: () => setShowNew(v => !v) },
        ].map(f => (
          <div key={f.label}>
            <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">{f.label}</label>
            <div className="relative">
              <input type={f.show ? "text" : "password"} value={f.value} onChange={e => f.onChange(e.target.value)} required className={fieldCls2 + " pr-10"} placeholder={f.label} />
              <button type="button" onClick={f.toggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink">{f.show ? <EyeOff size={15} /> : <Eye size={15} />}</button>
            </div>
          </div>
        ))}
        <div>
          <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Confirm New Password</label>
          <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required className={fieldCls2} placeholder="Re-enter new password" />
        </div>
        {error && <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 text-[12.5px] text-danger font-medium">{error}</div>}
        {success && <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2 text-[12.5px] text-success font-semibold"><Check size={13} strokeWidth={2.5} />{success}</div>}
        <button type="submit" disabled={saving} className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
          <Lock size={14} /> {saving ? "Changing…" : "Change Password"}
        </button>
      </form>
    </div>
  );
}
