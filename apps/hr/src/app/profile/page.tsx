"use client";
import { useState, useEffect, useRef } from "react";
import { apiFetch, apiUpload, API_BASE } from "@/lib/api";
import { Save, User, Building2, CreditCard, Users, FileText, Camera, CheckCircle, Clock, Upload, Lock, Eye, EyeOff } from "lucide-react";
import Link from "next/link";

interface ProfileData {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone?: string | null;
  profileImageUrl?: string | null;
  status: string;
  designation?: string | null;
  salary?: number | null;
  bankAccountHolderName?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  bankBranch?: string | null;
  ifscCode?: string | null;
  mailingAddress?: string | null;
  aadhaarNumber?: string | null;
  panNumber?: string | null;
  familyContact1Name?: string | null;
  familyContact1Phone?: string | null;
  familyContact1Relation?: string | null;
  familyContact2Name?: string | null;
  familyContact2Phone?: string | null;
  familyContact2Relation?: string | null;
}

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const selectClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [uploadingPic, setUploadingPic] = useState(false);
  const [picSuccess, setPicSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    bankAccountHolderName: "",
    bankAccountNumber: "",
    bankName: "",
    bankBranch: "",
    ifscCode: "",
    mailingAddress: "",
    aadhaarNumber: "",
    panNumber: "",
    familyContact1Name: "",
    familyContact1Phone: "",
    familyContact1Relation: "",
    familyContact2Name: "",
    familyContact2Phone: "",
    familyContact2Relation: "",
  });

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    try {
      const res: any = await apiFetch("/hr/profile");
      const p = res.data;
      setProfile(p);
      setForm({
        bankAccountHolderName: p.bankAccountHolderName || "",
        bankAccountNumber: p.bankAccountNumber || "",
        bankName: p.bankName || "",
        bankBranch: p.bankBranch || "",
        ifscCode: p.ifscCode || "",
        mailingAddress: p.mailingAddress || "",
        aadhaarNumber: p.aadhaarNumber || "",
        panNumber: p.panNumber || "",
        familyContact1Name: p.familyContact1Name || "",
        familyContact1Phone: p.familyContact1Phone || "",
        familyContact1Relation: p.familyContact1Relation || "",
        familyContact2Name: p.familyContact2Name || "",
        familyContact2Phone: p.familyContact2Phone || "",
        familyContact2Relation: p.familyContact2Relation || "",
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleProfilePicUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingPic(true);
    setPicSuccess("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      await apiUpload("/hr/profile-picture", formData);
      setPicSuccess("Profile picture submitted for admin approval!");
      setTimeout(() => setPicSuccess(""), 5000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploadingPic(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function updateForm(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSaving(true);
    try {
      const res: any = await apiFetch("/hr/profile", { method: "PUT", body: JSON.stringify(form) });
      setProfile(res.data);
      setSuccess("Profile updated successfully!");
      setTimeout(() => setSuccess(""), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">My Profile</h1>
        <p className="text-[#7A7A7A] mt-1">Update your personal and banking details</p>
      </div>

      {/* Basic Info (read-only) */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
            <User className="h-4 w-4 text-[#1A1A1A]" />
          </div>
          <h2 className="text-lg font-semibold text-[#1A1A1A]">Basic Information</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Name</label>
            <p className="text-sm font-medium text-[#1A1A1A] bg-[#FEFCF7] rounded-lg px-4 py-2.5 border border-[#E8E0D0]">{profile?.name}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Email</label>
            <p className="text-sm font-medium text-[#1A1A1A] bg-[#FEFCF7] rounded-lg px-4 py-2.5 border border-[#E8E0D0]">{profile?.email}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Phone</label>
            <p className="text-sm font-medium text-[#1A1A1A] bg-[#FEFCF7] rounded-lg px-4 py-2.5 border border-[#E8E0D0]">{profile?.phone || "Not set"}</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Designation</label>
            <p className="text-sm font-medium text-[#1A1A1A] bg-[#FEFCF7] rounded-lg px-4 py-2.5 border border-[#E8E0D0]">
              {profile?.designation || <span className="text-[#B0B0B0]">Assigned by Admin</span>}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Status</label>
            <span className={`inline-block text-xs font-semibold px-3 py-1.5 rounded-full ${
              profile?.status === "ACTIVE" ? "bg-green-50 text-green-700 border border-green-200" :
              profile?.status === "ONBOARDING" ? "bg-[#FFF3C4] text-[#1A1A1A]" :
              "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {profile?.status}
            </span>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Profile Picture</label>
            <div className="flex items-center gap-4">
              <div className="relative">
                {profile?.profileImageUrl ? (
                  <img src={profile.profileImageUrl.startsWith("http") ? profile.profileImageUrl : `${API_BASE}${profile.profileImageUrl}`} alt="Profile" className="h-16 w-16 rounded-xl object-cover border-2 border-[#E8E0D0]" />
                ) : (
                  <div className="h-16 w-16 rounded-xl bg-[#FFF3C4] flex items-center justify-center border-2 border-[#E8E0D0]">
                    <User className="h-6 w-6 text-[#7A7A7A]" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingPic}
                  className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-[#1A1A1A] text-white flex items-center justify-center hover:bg-[#2B2B2B] transition-colors shadow-md"
                >
                  <Camera className="h-3.5 w-3.5" />
                </button>
                <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleProfilePicUpload} className="hidden" />
              </div>
              {uploadingPic && <span className="text-xs text-[#7A7A7A] flex items-center gap-1"><Clock className="h-3 w-3" /> Uploading...</span>}
              {picSuccess && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle className="h-3 w-3" /> {picSuccess}</span>}
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Bank Details */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <CreditCard className="h-4 w-4 text-[#1A1A1A]" />
            </div>
            <h2 className="text-lg font-semibold text-[#1A1A1A]">Bank Account Details</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Account Holder Name</label>
              <input type="text" value={form.bankAccountHolderName} onChange={(e) => updateForm("bankAccountHolderName", e.target.value)} placeholder="Full name as per bank" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Bank Account Number</label>
              <input type="text" value={form.bankAccountNumber} onChange={(e) => updateForm("bankAccountNumber", e.target.value)} placeholder="Account number" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">IFSC Code</label>
              <input type="text" value={form.ifscCode} onChange={(e) => updateForm("ifscCode", e.target.value.toUpperCase())} placeholder="e.g. SBIN0001234" className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Bank Name</label>
              <input type="text" value={form.bankName} onChange={(e) => updateForm("bankName", e.target.value)} placeholder="e.g. State Bank of India" className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Branch Name</label>
              <input type="text" value={form.bankBranch} onChange={(e) => updateForm("bankBranch", e.target.value)} placeholder="e.g. Connaught Place, New Delhi" className={inputClass} />
            </div>
          </div>
        </div>

        {/* Mailing Address */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Building2 className="h-4 w-4 text-[#1A1A1A]" />
            </div>
            <h2 className="text-lg font-semibold text-[#1A1A1A]">Mailing Address</h2>
          </div>
          <textarea
            value={form.mailingAddress}
            onChange={(e) => updateForm("mailingAddress", e.target.value)}
            rows={3}
            placeholder="Full mailing address including PIN code..."
            className="w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors resize-none"
          />
        </div>

        {/* ID Proof */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                <FileText className="h-4 w-4 text-[#1A1A1A]" />
              </div>
              <h2 className="text-lg font-semibold text-[#1A1A1A]">ID Proof</h2>
            </div>
            <Link href="/documents" className="flex items-center gap-2 text-sm font-medium text-[#1A1A1A] bg-[#FFF3C4] hover:bg-[#FAE89E] px-4 py-2 rounded-full transition-colors">
              <Upload className="h-3.5 w-3.5" />
              Upload Documents
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Aadhaar Number</label>
              <input type="text" value={form.aadhaarNumber} onChange={(e) => updateForm("aadhaarNumber", e.target.value.replace(/\D/g, "").slice(0, 12))} placeholder="12-digit Aadhaar number" maxLength={12} className={inputClass} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">PAN Number</label>
              <input type="text" value={form.panNumber} onChange={(e) => updateForm("panNumber", e.target.value.toUpperCase().slice(0, 10))} placeholder="e.g. ABCDE1234F" maxLength={10} className={inputClass} />
            </div>
          </div>
          <p className="text-xs text-[#7A7A7A] mt-3">To upload identity proof documents (Aadhaar, PAN, etc.), go to <Link href="/documents" className="text-[#1A1A1A] underline hover:text-[#F5D547]">My Documents</Link>.</p>
        </div>

        {/* Family Contacts */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Users className="h-4 w-4 text-[#1A1A1A]" />
            </div>
            <h2 className="text-lg font-semibold text-[#1A1A1A]">Family Contacts (Emergency)</h2>
          </div>

          <div className="space-y-5">
            <p className="text-sm font-medium text-[#1A1A1A]">Contact 1</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Name</label>
                <input type="text" value={form.familyContact1Name} onChange={(e) => updateForm("familyContact1Name", e.target.value)} placeholder="Contact name" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Phone</label>
                <input type="tel" value={form.familyContact1Phone} onChange={(e) => updateForm("familyContact1Phone", e.target.value)} placeholder="+91..." className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Relation</label>
                <select value={form.familyContact1Relation} onChange={(e) => updateForm("familyContact1Relation", e.target.value)} className={selectClass}>
                  <option value="">Select...</option>
                  <option value="Father">Father</option>
                  <option value="Mother">Mother</option>
                  <option value="Spouse">Spouse</option>
                  <option value="Brother">Brother</option>
                  <option value="Sister">Sister</option>
                  <option value="Son">Son</option>
                  <option value="Daughter">Daughter</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <hr className="border-[#E8E0D0]" />

            <p className="text-sm font-medium text-[#1A1A1A]">Contact 2</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Name</label>
                <input type="text" value={form.familyContact2Name} onChange={(e) => updateForm("familyContact2Name", e.target.value)} placeholder="Contact name" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Phone</label>
                <input type="tel" value={form.familyContact2Phone} onChange={(e) => updateForm("familyContact2Phone", e.target.value)} placeholder="+91..." className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Relation</label>
                <select value={form.familyContact2Relation} onChange={(e) => updateForm("familyContact2Relation", e.target.value)} className={selectClass}>
                  <option value="">Select...</option>
                  <option value="Father">Father</option>
                  <option value="Mother">Mother</option>
                  <option value="Spouse">Spouse</option>
                  <option value="Brother">Brother</option>
                  <option value="Sister">Sister</option>
                  <option value="Son">Son</option>
                  <option value="Daughter">Daughter</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-3">
            <p className="text-sm text-green-700">{success}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="flex items-center gap-2 bg-[#1A1A1A] text-white px-8 py-3 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all shadow-md"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Profile"}
        </button>
      </form>

      {/* Password Change Section */}
      <PasswordChangeSection />
    </div>
  );
}

function PasswordChangeSection() {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (newPw.length < 6) { setError("New password must be at least 6 characters"); return; }
    if (newPw !== confirmPw) { setError("Passwords do not match"); return; }
    setSaving(true);
    try {
      await apiFetch("/hr/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      setSuccess("Password changed successfully!");
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (err: any) {
      setError(err.message || "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6 mt-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center"><Lock className="h-5 w-5 text-[#1A1A1A]" /></div>
        <h2 className="text-lg font-semibold text-[#1A1A1A]">Change Password</h2>
      </div>
      <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Current Password</label>
          <div className="relative">
            <input type={showCurrent ? "text" : "password"} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className={inputClass} required placeholder="Enter current password" />
            <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#1A1A1A]">
              {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">New Password</label>
          <div className="relative">
            <input type={showNew ? "text" : "password"} value={newPw} onChange={(e) => setNewPw(e.target.value)} className={inputClass} required placeholder="Enter new password (min 6 chars)" />
            <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#1A1A1A]">
              {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">Confirm New Password</label>
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className={inputClass} required placeholder="Re-enter new password" />
        </div>
        {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        {success && <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{success}</p>}
        <button type="submit" disabled={saving} className="flex items-center gap-2 bg-[#1A1A1A] text-white px-6 py-2.5 rounded-full font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
          <Lock className="h-4 w-4" /> {saving ? "Changing..." : "Change Password"}
        </button>
      </form>
    </div>
  );
}
