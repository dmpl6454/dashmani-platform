"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useEmployee } from "@/lib/hooks/use-employees";
import { EmployeeForm } from "@/components/employee-form";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import Link from "next/link";
import {
  User, FileText, Clock, IndianRupee, Award, BarChart3, Briefcase, CreditCard,
  Users as UsersIcon, Plus, Check, X, Eye, MonitorSmartphone, ExternalLink, ListTodo, Laptop, Smartphone, Monitor, Headphones,
} from "lucide-react";
import { getRoleColor } from "@/lib/role-colors";
import { useAuth } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { formatStatus } from "@dashmani/shared";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const { data, isLoading } = useEmployee(id as string);
  const [roles, setRoles] = useState([]);
  const [activeTab, setActiveTab] = useState<"profile" | "accounts" | "documents" | "hours" | "incentives" | "reviews" | "tasks" | "devices">("profile");

  // Fetch additional data
  const { data: profileData, mutate: mutateProfile } = useSWR(id ? `/admin/employees/${id}/profile-data` : null, (url: string) => apiFetch<any>(url).catch(() => null));
  const { data: docsData } = useSWR(id ? `/admin/documents?employeeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: extraHoursData, mutate: mutateHours } = useSWR(id ? `/admin/extra-hours?employeeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: incentivesData, mutate: mutateIncentives } = useSWR(id ? `/admin/incentives?employeeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: reviewsData, mutate: mutateReviews } = useSWR(id ? `/admin/performance-reviews?employeeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: accountsData } = useSWR(id ? `/employees/${id}/accounts` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: tasksData } = useSWR(id ? `/tasks?assigneeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));
  const { data: devicesData } = useSWR(id ? `/admin/devices?employeeId=${id}` : null, (url: string) => apiFetch<any>(url).catch(() => ({ data: [] })));

  const [jdForm, setJdForm] = useState("");
  const [savingJd, setSavingJd] = useState(false);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileEditForm, setProfileEditForm] = useState<Record<string, string>>({});
  const [savingProfile, setSavingProfile] = useState(false);
  const [incentiveForm, setIncentiveForm] = useState({ amount: "", reason: "", month: "", year: "" });
  const [addingIncentive, setAddingIncentive] = useState(false);
  const [reviewForm, setReviewForm] = useState({ period: "", rating: "3", strengths: "", improvements: "", comments: "", goals: "" });
  const [addingReview, setAddingReview] = useState(false);

  useEffect(() => {
    apiFetch("/roles").then((res: any) => setRoles(res.data));
  }, []);

  useEffect(() => {
    if (profileData?.data?.jobDescription) setJdForm(profileData.data.jobDescription);
  }, [profileData]);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;

  const employee = (data as any)?.data;
  if (!employee) return <div className="text-[#7A7A7A] text-center py-8">Employee not found</div>;

  const profile = profileData?.data;
  const docs = docsData?.data || [];
  const extraHours = extraHoursData?.data || [];
  const incentives = incentivesData?.data || [];
  const reviews = reviewsData?.data || [];
  const assignedAccounts = accountsData?.data || [];
  const tasks = tasksData?.data || [];
  const employeeDevices = devicesData?.data || [];

  async function saveJobDescription() {
    setSavingJd(true);
    try {
      await apiFetch(`/admin/employees/${id}/job-description`, {
        method: "PUT",
        body: JSON.stringify({ jobDescription: jdForm }),
      });
    } catch (e: any) { alert(e.message); }
    finally { setSavingJd(false); }
  }

  function startEditProfile() {
    const p = profileData?.data || {};
    setProfileEditForm({
      bankName: p.bankName || "",
      bankAccountNumber: p.bankAccountNumber || "",
      bankAccountHolderName: p.bankAccountHolderName || "",
      bankBranch: p.bankBranch || "",
      ifscCode: p.ifscCode || "",
      aadhaarNumber: p.aadhaarNumber || "",
      panNumber: p.panNumber || "",
      mailingAddress: p.mailingAddress || "",
      familyContact1Name: p.familyContact1Name || "",
      familyContact1Phone: p.familyContact1Phone || "",
      familyContact1Relation: p.familyContact1Relation || "",
      familyContact2Name: p.familyContact2Name || "",
      familyContact2Phone: p.familyContact2Phone || "",
      familyContact2Relation: p.familyContact2Relation || "",
    });
    setIsEditingProfile(true);
  }

  async function saveProfileData(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await apiFetch(`/admin/employees/${id}/profile-data`, {
        method: "PUT",
        body: JSON.stringify(profileEditForm),
      });
      mutateProfile();
      setIsEditingProfile(false);
    } catch (e: any) { alert(e.message); }
    finally { setSavingProfile(false); }
  }

  async function handleAddIncentive(e: React.FormEvent) {
    e.preventDefault();
    setAddingIncentive(true);
    try {
      await apiFetch("/admin/incentives", {
        method: "POST",
        body: JSON.stringify({
          employeeId: id,
          amount: Number(incentiveForm.amount),
          reason: incentiveForm.reason,
          month: incentiveForm.month ? Number(incentiveForm.month) : undefined,
          year: incentiveForm.year ? Number(incentiveForm.year) : undefined,
        }),
      });
      setIncentiveForm({ amount: "", reason: "", month: "", year: "" });
      mutateIncentives();
    } catch (e: any) { alert(e.message); }
    finally { setAddingIncentive(false); }
  }

  async function handleAddReview(e: React.FormEvent) {
    e.preventDefault();
    setAddingReview(true);
    try {
      await apiFetch("/admin/performance-reviews", {
        method: "POST",
        body: JSON.stringify({ employeeId: id, ...reviewForm, rating: Number(reviewForm.rating) }),
      });
      setReviewForm({ period: "", rating: "3", strengths: "", improvements: "", comments: "", goals: "" });
      mutateReviews();
    } catch (e: any) { alert(e.message); }
    finally { setAddingReview(false); }
  }

  async function handleExtraHourAction(ehId: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/admin/extra-hours/${ehId}/${action}`, { method: "POST" });
      mutateHours();
    } catch (e: any) { alert(e.message); }
  }

  const callerRoles = (currentUser?.roles ?? []).map((r) => r.toLowerCase());
  const isAdminOrSuperAdmin = callerRoles.includes("super admin") || callerRoles.includes("admin");

  async function handleDeleteEmployee() {
    if (!confirm(`Are you sure you want to delete ${employee.name}? This action cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/users/${id}`, { method: "DELETE" });
      router.push("/employees");
    } catch (e: any) { alert(e.message); }
  }

  const tabs = [
    { key: "profile" as const, label: "Profile & Edit", icon: User },
    { key: "tasks" as const, label: "Tasks", icon: ListTodo, count: tasks.filter((t: any) => t.status !== "DONE").length },
    { key: "accounts" as const, label: "Accounts", icon: MonitorSmartphone, count: assignedAccounts.length },
    { key: "documents" as const, label: "Documents", icon: FileText, count: docs.length },
    { key: "hours" as const, label: "Extra Hours", icon: Clock, count: extraHours.filter((h: any) => h.status === "PENDING").length },
    { key: "incentives" as const, label: "Incentives", icon: IndianRupee },
    { key: "reviews" as const, label: "Reviews", icon: Award },
    { key: "devices" as const, label: "Devices", icon: Laptop, count: employeeDevices.length },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative">
            {employee.profileImageUrl ? (
              <img src={employee.profileImageUrl.startsWith("http") ? employee.profileImageUrl : `${API_BASE}${employee.profileImageUrl}`} alt="" className="h-16 w-16 rounded-2xl object-cover border-2 border-[#E8E0D0]" />
            ) : (
              <div className="h-16 w-16 rounded-2xl bg-[#FFF3C4] flex items-center justify-center border-2 border-[#E8E0D0]">
                <User className="h-7 w-7 text-[#7A7A7A]" />
              </div>
            )}
          </div>
          <div>
            <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">{employee.name}</h1>
            <p className="text-sm text-[#7A7A7A]">{employee.email} {profile?.designation ? `· ${profile.designation}` : ""}</p>
            {employee.roles?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {employee.roles.map((r: any) => (
                  <span key={r.id} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${getRoleColor(r.name)}`}>{r.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/employees/${id}/performance`}
            className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-all"
          >
            <BarChart3 className="h-4 w-4" /> Performance
          </Link>
          {isAdminOrSuperAdmin && (
            <button
              onClick={handleDeleteEmployee}
              className="flex items-center gap-2 border border-red-200 text-red-600 py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-red-50 transition-all"
            >
              <X className="h-4 w-4" /> Delete
            </button>
          )}
        </div>
      </div>

      {/* Quick Stats */}
      {profile && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
            <p className="text-xs text-[#7A7A7A]">Salary</p>
            <p className="text-lg font-semibold text-[#1A1A1A]">{profile.salary ? formatCurrency(profile.salary) : "—"}</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
            <p className="text-xs text-[#7A7A7A]">Status</p>
            <span className={`inline-block text-xs font-semibold px-3 py-1 rounded-full ${
              employee.status === "ACTIVE" ? "bg-green-50 text-green-700" :
              employee.status === "ONBOARDING" ? "bg-[#FFF3C4] text-[#1A1A1A]" :
              "bg-red-50 text-red-700"
            }`}>{formatStatus(employee.status)}</span>
          </div>
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
            <p className="text-xs text-[#7A7A7A]">Total Incentives</p>
            <p className="text-lg font-semibold text-[#1A1A1A]">{formatCurrency(incentives.reduce((s: number, i: any) => s + i.amount, 0))}</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4">
            <p className="text-xs text-[#7A7A7A]">Avg Review Rating</p>
            <p className="text-lg font-semibold text-[#1A1A1A]">{reviews.length ? (reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length).toFixed(1) + "/5" : "—"}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[#E8E0D0] overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#F5D547] text-[#1A1A1A]"
                  : "border-transparent text-[#7A7A7A] hover:text-[#1A1A1A]"
              }`}
            >
              <Icon size={16} />
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className="ml-1 bg-[rgba(245,213,71,0.25)] text-[#B8960C] text-xs font-semibold rounded-full px-2 py-0.5">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Profile Tab */}
      {activeTab === "profile" && (
        <div className="space-y-6">
          {/* Employee Form (edit basic info) */}
          <div className="max-w-2xl">
            <EmployeeForm employee={employee} roles={roles} />
          </div>

          {/* Role Management — admin/super-admin only */}
          {isAdminOrSuperAdmin && (
            <RoleManager employeeId={id as string} allRoles={roles} currentRoles={employee.roles ?? []} />
          )}

          {/* Job Description */}
          <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
            <div className="flex items-center gap-3 mb-4">
              <Briefcase className="h-5 w-5 text-[#7A7A7A]" />
              <h3 className="text-lg font-semibold text-[#1A1A1A]">Job Description</h3>
            </div>
            <textarea
              value={jdForm}
              onChange={(e) => setJdForm(e.target.value)}
              rows={5}
              placeholder="Enter job description, responsibilities, and expectations..."
              className="w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] transition-colors resize-none"
            />
            <div className="mt-3 flex justify-end">
              <button onClick={saveJobDescription} disabled={savingJd} className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
                {savingJd ? "Saving..." : "Save Job Description"}
              </button>
            </div>
          </div>

          {/* Employee Submitted Data — editable by admin */}
          {profile && (
            <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-[#1A1A1A] flex items-center gap-2"><CreditCard className="h-5 w-5 text-[#7A7A7A]" /> Employee Submitted Data</h3>
                {!isEditingProfile && (
                  <button onClick={startEditProfile} className="flex items-center gap-1.5 text-xs text-[#7A7A7A] hover:text-[#1A1A1A] border border-[#F0EAD8] hover:border-[#E8D8B4] rounded-lg px-3 py-1.5 transition-all">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    Edit
                  </button>
                )}
              </div>

              {isEditingProfile ? (
                <form onSubmit={saveProfileData} className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wider mb-3">Bank Details</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {[
                        { key: "bankName", label: "Bank Name" },
                        { key: "bankAccountNumber", label: "Account Number" },
                        { key: "bankAccountHolderName", label: "Account Holder" },
                        { key: "bankBranch", label: "Branch" },
                        { key: "ifscCode", label: "IFSC Code" },
                      ].map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wider mb-3">ID Documents</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[{ key: "aadhaarNumber", label: "Aadhaar Number" }, { key: "panNumber", label: "PAN Number" }].map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#7A7A7A] mb-1">Mailing Address</label>
                    <textarea rows={2} className={inputClass + " resize-none"} value={profileEditForm.mailingAddress || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, mailingAddress: e.target.value })} placeholder="Full mailing address" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wider mb-3">Emergency Contacts</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                      {[{ key: "familyContact1Name", label: "Contact 1 Name" }, { key: "familyContact1Relation", label: "Relation" }, { key: "familyContact1Phone", label: "Phone" }].map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {[{ key: "familyContact2Name", label: "Contact 2 Name" }, { key: "familyContact2Relation", label: "Relation" }, { key: "familyContact2Phone", label: "Phone" }].map(({ key, label }) => (
                        <div key={key}>
                          <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button type="submit" disabled={savingProfile} className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
                      <Check className="h-3.5 w-3.5" /> {savingProfile ? "Saving..." : "Save Changes"}
                    </button>
                    <button type="button" onClick={() => setIsEditingProfile(false)} className="flex items-center gap-2 border border-[#F0EAD8] text-[#7A7A7A] py-2 px-5 rounded-full text-sm hover:border-[#E8D8B4] transition-all">
                      <X className="h-3.5 w-3.5" /> Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
                    <InfoField label="Bank Name" value={profile.bankName} />
                    <InfoField label="Account Number" value={profile.bankAccountNumber} />
                    <InfoField label="IFSC Code" value={profile.ifscCode} />
                    <InfoField label="Account Holder" value={profile.bankAccountHolderName} />
                    <InfoField label="Bank Branch" value={profile.bankBranch} />
                    <InfoField label="Aadhaar" value={profile.aadhaarNumber} />
                    <InfoField label="PAN" value={profile.panNumber} />
                    <InfoField label="Mailing Address" value={profile.mailingAddress} />
                  </div>
                  {(profile.familyContact1Name || profile.familyContact2Name) && (
                    <>
                      <h4 className="text-sm font-semibold text-[#1A1A1A] flex items-center gap-2 pt-2"><UsersIcon className="h-4 w-4 text-[#7A7A7A]" /> Emergency Contacts</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                        {profile.familyContact1Name && <InfoField label="Contact 1" value={`${profile.familyContact1Name} (${profile.familyContact1Relation || "—"}) - ${profile.familyContact1Phone || "—"}`} />}
                        {profile.familyContact2Name && <InfoField label="Contact 2" value={`${profile.familyContact2Name} (${profile.familyContact2Relation || "—"}) - ${profile.familyContact2Phone || "—"}`} />}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tasks Tab */}
      {activeTab === "tasks" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Task</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Priority</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Due Date</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Account</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-[#7A7A7A]"><ListTodo className="h-8 w-8 mx-auto mb-2 opacity-30" />No tasks assigned</td></tr>
                ) : tasks.map((task: any) => (
                  <tr key={task.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)]">
                    <td className="p-4">
                      <p className="font-medium text-[#1A1A1A]">{task.title}</p>
                      {task.description && <p className="text-xs text-[#7A7A7A] mt-0.5 line-clamp-1">{task.description}</p>}
                    </td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        task.priority === "HIGH" || task.priority === "URGENT" ? "bg-red-50 text-red-700" :
                        task.priority === "MEDIUM" ? "bg-yellow-50 text-yellow-700" :
                        "bg-blue-50 text-blue-700"
                      }`}>{task.priority}</span>
                    </td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        task.status === "DONE" ? "bg-green-50 text-green-700" :
                        task.status === "IN_PROGRESS" ? "bg-blue-50 text-blue-700" :
                        "bg-gray-100 text-gray-700"
                      }`}>{formatStatus(task.status)}</span>
                    </td>
                    <td className="p-4 text-[#7A7A7A]">{task.dueDate ? new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "\u2014"}</td>
                    <td className="p-4 text-[#7A7A7A]">{task.account?.handle || task.account?.displayName || "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Accounts Tab */}
      {activeTab === "accounts" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          {assignedAccounts.length === 0 ? (
            <div className="p-10 text-center text-[#7A7A7A]">
              <MonitorSmartphone className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium mb-1">No accounts assigned</p>
              <p className="text-sm">Assign social media accounts from the <Link href="/accounts" className="text-blue-600 hover:underline">Accounts</Link> page.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
              {assignedAccounts.map((a: any) => (
                <div key={a.id} className="border border-[#E8E0D0] rounded-xl p-4 hover:border-[#F5D547] transition-colors">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center text-lg font-bold text-[#1A1A1A]">
                      {a.account?.platform?.name?.[0] || "?"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#1A1A1A] truncate">{a.account?.displayName || a.account?.handle}</p>
                      <p className="text-xs text-[#7A7A7A]">{a.account?.platform?.name} · @{a.account?.handle}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5 text-xs text-[#7A7A7A]">
                    {a.account?.clientName && <p>Client: <span className="text-[#1A1A1A] font-medium">{a.account.clientName}</span></p>}
                    <p>Followers: <span className="text-[#1A1A1A] font-medium">{(a.account?.followerCount || 0).toLocaleString()}</span></p>
                    <p>Assigned: <span className="text-[#1A1A1A] font-medium">{new Date(a.assignedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></p>
                    {a.assigner && <p>By: <span className="text-[#1A1A1A] font-medium">{a.assigner.name}</span></p>}
                  </div>
                  {a.account?.profileUrl && (
                    <a href={a.account.profileUrl} target="_blank" rel="noopener noreferrer" className="mt-3 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium">
                      <ExternalLink size={12} /> View Profile
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Type</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Filename</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Uploaded</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-[#7A7A7A]">No documents uploaded</td></tr>
                ) : docs.map((doc: any) => (
                  <tr key={doc.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)]">
                    <td className="p-4 font-medium">{doc.documentType}</td>
                    <td className="p-4">{doc.fileName}</td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        doc.status === "APPROVED" ? "bg-green-50 text-green-700" :
                        doc.status === "REJECTED" ? "bg-red-50 text-red-700" :
                        "bg-yellow-50 text-yellow-700"
                      }`}>{formatStatus(doc.status)}</span>
                    </td>
                    <td className="p-4 text-[#7A7A7A]">{new Date(doc.createdAt).toLocaleDateString()}</td>
                    <td className="p-4">
                      {doc.filePath && (
                        <a
                          href={doc.filePath.startsWith("http") ? doc.filePath : `${API_BASE}${doc.filePath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs font-medium text-[#1A1A1A] hover:text-[#F5D547] transition-colors"
                        >
                          <Eye size={13} /> View
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Extra Hours Tab */}
      {activeTab === "hours" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Hours</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Description</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {extraHours.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-[#7A7A7A]">No extra work hours logged</td></tr>
                ) : extraHours.map((eh: any) => (
                  <tr key={eh.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)]">
                    <td className="p-4 font-medium">{new Date(eh.date).toLocaleDateString()}</td>
                    <td className="p-4">{eh.hours}h</td>
                    <td className="p-4 text-[#7A7A7A] max-w-[200px] truncate">{eh.description || "—"}</td>
                    <td className="p-4">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                        eh.status === "APPROVED" ? "bg-green-50 text-green-700" :
                        eh.status === "REJECTED" ? "bg-red-50 text-red-700" :
                        "bg-yellow-50 text-yellow-700"
                      }`}>{formatStatus(eh.status)}</span>
                    </td>
                    <td className="p-4">
                      {eh.status === "PENDING" && (
                        <div className="flex gap-2">
                          <button onClick={() => handleExtraHourAction(eh.id, "approve")} className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-[#2E7D32] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)]">
                            <Check size={13} /> Approve
                          </button>
                          <button onClick={() => handleExtraHourAction(eh.id, "reject")} className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-[#E74C3C] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)]">
                            <X size={13} /> Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Incentives Tab */}
      {activeTab === "incentives" && (
        <div className="space-y-5">
          <form onSubmit={handleAddIncentive} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
            <p className="font-medium text-[#1A1A1A] mb-3 flex items-center gap-2"><Plus size={16} /> Award Incentive</p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input type="number" placeholder="Amount (₹)" value={incentiveForm.amount} onChange={(e) => setIncentiveForm({ ...incentiveForm, amount: e.target.value })} required className={inputClass} />
              <input type="text" placeholder="Reason" value={incentiveForm.reason} onChange={(e) => setIncentiveForm({ ...incentiveForm, reason: e.target.value })} required className={inputClass} />
              <input type="number" placeholder="Month (1-12)" min="1" max="12" value={incentiveForm.month} onChange={(e) => setIncentiveForm({ ...incentiveForm, month: e.target.value })} className={inputClass} />
              <input type="number" placeholder="Year" value={incentiveForm.year} onChange={(e) => setIncentiveForm({ ...incentiveForm, year: e.target.value })} className={inputClass} />
            </div>
            <div className="mt-3 flex justify-end">
              <button type="submit" disabled={addingIncentive} className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
                {addingIncentive ? "Adding..." : "Award Incentive"}
              </button>
            </div>
          </form>

          <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#F0EAD8]">
                    <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Amount</th>
                    <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Reason</th>
                    <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Period</th>
                    <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {incentives.length === 0 ? (
                    <tr><td colSpan={4} className="p-8 text-center text-[#7A7A7A]">No incentives awarded</td></tr>
                  ) : incentives.map((inc: any) => (
                    <tr key={inc.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)]">
                      <td className="p-4 font-semibold text-[#1A1A1A]">{formatCurrency(inc.amount)}</td>
                      <td className="p-4">{inc.reason}</td>
                      <td className="p-4 text-[#7A7A7A]">{inc.month && inc.year ? `${inc.month}/${inc.year}` : "—"}</td>
                      <td className="p-4 text-[#7A7A7A]">{new Date(inc.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Reviews Tab */}
      {activeTab === "reviews" && (
        <div className="space-y-5">
          <form onSubmit={handleAddReview} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
            <p className="font-medium text-[#1A1A1A] mb-3 flex items-center gap-2"><Plus size={16} /> Add Performance Review</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input type="text" placeholder="Review Period (e.g., Q1 2026)" value={reviewForm.period} onChange={(e) => setReviewForm({ ...reviewForm, period: e.target.value })} required className={inputClass} />
              <select value={reviewForm.rating} onChange={(e) => setReviewForm({ ...reviewForm, rating: e.target.value })} className={inputClass}>
                <option value="1">1 - Needs Improvement</option>
                <option value="2">2 - Below Expectations</option>
                <option value="3">3 - Meets Expectations</option>
                <option value="4">4 - Exceeds Expectations</option>
                <option value="5">5 - Outstanding</option>
              </select>
              <textarea placeholder="Strengths..." value={reviewForm.strengths} onChange={(e) => setReviewForm({ ...reviewForm, strengths: e.target.value })} rows={2} className={inputClass} />
              <textarea placeholder="Areas for Improvement..." value={reviewForm.improvements} onChange={(e) => setReviewForm({ ...reviewForm, improvements: e.target.value })} rows={2} className={inputClass} />
              <textarea placeholder="Comments..." value={reviewForm.comments} onChange={(e) => setReviewForm({ ...reviewForm, comments: e.target.value })} rows={2} className={inputClass} />
              <textarea placeholder="Goals for Next Period..." value={reviewForm.goals} onChange={(e) => setReviewForm({ ...reviewForm, goals: e.target.value })} rows={2} className={inputClass} />
            </div>
            <div className="mt-3 flex justify-end">
              <button type="submit" disabled={addingReview} className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
                {addingReview ? "Submitting..." : "Submit Review"}
              </button>
            </div>
          </form>

          <div className="space-y-4">
            {reviews.length === 0 ? (
              <div className="bg-white rounded-2xl border border-[#E8E0D0] p-8 text-center text-[#7A7A7A]">No reviews yet</div>
            ) : reviews.map((review: any) => (
              <div key={review.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-semibold text-[#1A1A1A]">{review.period}</p>
                    <p className="text-xs text-[#7A7A7A]">by {review.reviewer?.name ?? "Unknown Reviewer"} · {new Date(review.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {[1,2,3,4,5].map(s => (
                      <div key={s} className={`h-3 w-3 rounded-full ${s <= review.rating ? "bg-[#F5D547]" : "bg-[#E8E0D0]"}`} />
                    ))}
                    <span className="ml-2 text-sm font-semibold">{review.rating}/5</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  {review.strengths && <div><p className="text-xs text-[#7A7A7A] mb-1">Strengths</p><p>{review.strengths}</p></div>}
                  {review.improvements && <div><p className="text-xs text-[#7A7A7A] mb-1">Improvements</p><p>{review.improvements}</p></div>}
                  {review.comments && <div><p className="text-xs text-[#7A7A7A] mb-1">Comments</p><p>{review.comments}</p></div>}
                  {review.goals && <div><p className="text-xs text-[#7A7A7A] mb-1">Goals</p><p>{review.goals}</p></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices Tab */}
      {activeTab === "devices" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          {employeeDevices.length === 0 ? (
            <div className="p-10 text-center text-[#7A7A7A]">
              <Laptop className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium mb-1">No devices assigned</p>
              <p className="text-sm">Assign devices from the <Link href="/devices" className="text-blue-600 hover:underline">Devices</Link> page.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-5">
              {employeeDevices.map((d: any) => {
                const Icon = d.type === "PHONE" || d.type === "TABLET" ? Smartphone : d.type === "MONITOR" ? Monitor : d.type === "HEADSET" ? Headphones : Laptop;
                return (
                  <div key={d.id} className="border border-[#E8E0D0] rounded-xl p-4 hover:border-[#F5D547] transition-colors">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                        <Icon className="h-5 w-5 text-[#B8960C]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-[#1A1A1A] truncate">{d.brand} {d.model}</p>
                        <p className="text-xs text-[#7A7A7A]">{d.type}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5 text-xs text-[#7A7A7A]">
                      <p>Condition: <span className="text-[#1A1A1A] font-medium">{d.condition}</span></p>
                      {d.serialNumber && <p>S/N: <span className="text-[#1A1A1A] font-medium">{d.serialNumber}</span></p>}
                      {d.assetTag && <p>Tag: <span className="text-[#1A1A1A] font-medium">{d.assetTag}</span></p>}
                      <p>Assigned: <span className="text-[#1A1A1A] font-medium">{new Date(d.assignedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></p>
                      {d.notes && <p className="text-[#7A7A7A] italic mt-1">{d.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs text-[#7A7A7A] mb-0.5">{label}</p>
      <p className="text-[#1A1A1A] bg-[#FEFCF7] rounded-lg px-3 py-2 border border-[#E8E0D0]">{value || "—"}</p>
    </div>
  );
}

function RoleManager({ employeeId, allRoles, currentRoles }: { employeeId: string; allRoles: any[]; currentRoles: any[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentRoles.map((r: any) => r.id)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function toggle(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiFetch(`/admin/users/${employeeId}/roles`, {
        method: "PUT",
        body: JSON.stringify({ roleIds: Array.from(selected) }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-4">
        <UsersIcon className="h-5 w-5 text-[#7A7A7A]" />
        <h3 className="text-lg font-semibold text-[#1A1A1A]">Role Assignment</h3>
      </div>
      <p className="text-xs text-[#7A7A7A] mb-4">Roles control what this employee can see and do across the portal.</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {allRoles.map((role: any) => {
          const active = selected.has(role.id);
          return (
            <button
              key={role.id}
              onClick={() => toggle(role.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                active
                  ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                  : "bg-white text-[#7A7A7A] border-[#E8E0D0] hover:border-[#B0B0B0]"
              }`}
            >
              {active ? <Check size={11} /> : <Plus size={11} />}
              {role.name}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-[#1A1A1A] text-white py-2 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all"
        >
          {saving ? "Saving..." : "Save Roles"}
        </button>
        {saved && <span className="text-xs text-emerald-600 font-medium flex items-center gap-1"><Check size={12} /> Roles updated</span>}
      </div>
    </div>
  );
}
