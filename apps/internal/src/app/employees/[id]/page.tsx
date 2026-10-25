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
  Users as UsersIcon, Plus, Check, X, Eye, MonitorSmartphone, ExternalLink, ListTodo, Laptop, Smartphone, Monitor, Headphones, AlertCircle, CheckCircle2, ChevronLeft, Pencil,
} from "lucide-react";
import { PlatformIcon } from "@/lib/platform-icon";
import { useAuth } from "@/lib/auth";
import { useRouter } from "next/navigation";
import { formatStatus } from "@dashmani/shared";
import { BoxesLoader } from "@/components/boxes-loader";

// Premium dark ("ds") styling — same tokens/idiom as /employees, /devices and /settings.
const inputClass =
  "w-full min-h-[42px] px-3 py-2.5 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0 transition-colors";
const CARD = "rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const CARD_TITLE = "text-[16px] font-semibold tracking-[-.01em] text-ds-text";
const ICON_TILE = "h-9 w-9 rounded-[10px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.28)] text-ds-gold grid place-items-center shrink-0";
const FIELD_LABEL = "block text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-[7px]";
const SECTION_LABEL = "text-[10.5px] font-semibold tracking-[.12em] uppercase text-ds-t3 mb-3";
const GOLD_BTN =
  "inline-flex items-center justify-center gap-2 h-10 px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold whitespace-nowrap transition-colors hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";
const GHOST_BTN =
  "inline-flex items-center justify-center gap-2 h-10 px-5 rounded-full border border-ds-line2 bg-ds-card text-ds-t5 text-[13px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text disabled:opacity-60";
const TH = "text-left px-5 py-3 text-[10.5px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap";
const TD = "px-5 py-3.5";
const TR = "border-b border-[color:var(--hx-132430)] last:border-0 hover:bg-[color:var(--hx-0A1620)] transition-colors";
const THEAD_ROW = "bg-ds-inset border-b border-ds-line2";
const MINI_CARD = "rounded-[12px] border border-ds-line2 bg-ds-inset p-4 transition-colors hover:border-[rgba(233,189,98,.5)]";
const STRONG = "text-ds-t5 font-medium";

const rgba = (hex: string, a: number) => { if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const GREEN = "var(--hx-00D7A0)", AMBER = "var(--hx-FBBF24)", RED = "var(--hx-FB7185)", BLUE = "var(--hx-6EB2FF)", GREY = "var(--hx-738395)", PURPLE = "var(--hx-9B7EDE)";

// Dark-tinted chip, matching the role/status chips on /employees.
function Pill({ color, children, dot = false }: { color: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap"
      style={{ color, background: rgba(color, 0.1), borderColor: rgba(color, 0.3) }}
    >
      {dot && <i className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

// Role chip colours — same palette as the /employees roster.
const ROLE_COLOR: Record<string, string> = {
  "super admin": "var(--hx-E9BD62)", admin: "var(--hx-E9BD62)", "team lead": "var(--hx-9B7EDE)", manager: "var(--hx-9B7EDE)",
  "senior employee": "var(--hx-00D7A0)", employee: "var(--hx-238BFF)", hr: "var(--hx-FB7185)", designer: "var(--hx-EC42B7)", editor: "var(--hx-00D7A0)", developer: "var(--hx-00D7A0)",
};
const ROLE_FALLBACK = ["var(--hx-238BFF)", "var(--hx-00D7A0)", "var(--hx-9B7EDE)", "var(--hx-EC42B7)", "var(--hx-FB7185)"];
const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const roleColor = (name: string) => ROLE_COLOR[(name || "").toLowerCase()] ?? ROLE_FALLBACK[hashStr(name || "") % ROLE_FALLBACK.length];

const statusColor = (s: string) => (s === "APPROVED" || s === "ACTIVE" || s === "DONE" ? GREEN : s === "REJECTED" || s === "INACTIVE" ? RED : s === "IN_PROGRESS" ? BLUE : s === "PENDING" || s === "ONBOARDING" ? AMBER : GREY);
const priorityColor = (p: string) => (p === "HIGH" || p === "URGENT" ? RED : p === "MEDIUM" ? AMBER : BLUE);

function formatCurrency(n: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const { data, isLoading, mutate: mutateEmployee } = useEmployee(id as string) as any;
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
  const [pageError, setPageError] = useState<string | null>(null);
  const [pageSuccess, setPageSuccess] = useState<string | null>(null);

  function showError(msg: string) {
    setPageError(msg);
    setPageSuccess(null);
    setTimeout(() => setPageError(null), 6000);
  }
  function showSuccess(msg: string) {
    setPageSuccess(msg);
    setPageError(null);
    setTimeout(() => setPageSuccess(null), 4000);
  }

  useEffect(() => {
    apiFetch("/roles").then((res: any) => setRoles(res.data));
  }, []);

  useEffect(() => {
    if (profileData?.data?.jobDescription) setJdForm(profileData.data.jobDescription);
  }, [profileData]);

  if (isLoading) return <div className="flex items-center justify-center h-64"><BoxesLoader /></div>;

  const employee = (data as any)?.data;
  if (!employee) return (
    <div className="py-20 text-center">
      <p className="text-[13px] text-ds-t3">Employee not found</p>
      <Link href="/employees" className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ds-t2 hover:text-ds-gold">
        <ChevronLeft className="h-3.5 w-3.5" /> Back to employees
      </Link>
    </div>
  );

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
      showSuccess("Job description saved.");
    } catch (e: any) { showError(e.message); }
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
      showSuccess("Profile data saved.");
    } catch (e: any) { showError(e.message); }
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
      showSuccess("Incentive awarded.");
    } catch (e: any) { showError(e.message); }
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
      showSuccess("Review submitted.");
    } catch (e: any) { showError(e.message); }
    finally { setAddingReview(false); }
  }

  async function handleExtraHourAction(ehId: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/admin/extra-hours/${ehId}/${action}`, { method: "POST" });
      mutateHours();
      showSuccess(`Extra hours ${action}d.`);
    } catch (e: any) { showError(e.message); }
  }

  const callerRoles = (currentUser?.roles ?? []).map((r) => r.toLowerCase());
  const isAdminOrSuperAdmin = callerRoles.includes("super admin") || callerRoles.includes("admin");

  async function handleDeleteEmployee() {
    if (!confirm(`Are you sure you want to delete ${employee.name}? This action cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/users/${id}`, { method: "DELETE" });
      router.push("/employees");
    } catch (e: any) { showError(e.message); }
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
    <div className="pb-8 space-y-5">
      {/* Back link */}
      <div className="pt-[22px]">
        <Link href="/employees" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ds-t2 hover:text-ds-gold transition-colors">
          <ChevronLeft className="h-3.5 w-3.5" /> Employees
        </Link>
      </div>

      {/* Page-level notifications */}
      {pageError && (
        <div role="alert" className="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] font-medium">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {pageError}
        </div>
      )}
      {pageSuccess && (
        <div role="status" className="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-ds-teal text-[12.5px] font-medium">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {pageSuccess}
        </div>
      )}

      {/* Header — stacks vertically on phones so the long name + action buttons
          never fight for the same row; sm+ keeps the original side-by-side layout */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div className="relative shrink-0">
            {employee.profileImageUrl ? (
              <img src={employee.profileImageUrl.startsWith("http") ? employee.profileImageUrl : `${API_BASE}${employee.profileImageUrl}`} alt="" className="h-12 w-12 sm:h-16 sm:w-16 rounded-[16px] object-cover border-2 border-[rgba(233,189,98,.45)]" />
            ) : (
              <div className="h-12 w-12 sm:h-16 sm:w-16 rounded-[16px] bg-[rgba(233,189,98,.1)] flex items-center justify-center border-2 border-[rgba(233,189,98,.45)]">
                <User className="h-5 w-5 sm:h-7 sm:w-7 text-ds-gold" />
              </div>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="m-0 text-[20px] sm:text-[26px] font-semibold tracking-[-.02em] text-ds-text truncate">{employee.name}</h1>
            <p className="mt-1 text-[12px] sm:text-[13.5px] text-ds-t2 truncate">{employee.email} {profile?.designation ? `· ${profile.designation}` : ""}</p>
            {employee.roles?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {employee.roles.map((r: any) => {
                  const role = r.role ?? r;
                  return (
                  <Pill key={role.id} color={roleColor(role.name)}>{role.name}</Pill>
                  );
                })}
              </div>
            )}
            {employee.teams?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <span className="text-[11px] text-ds-t3">Teams:</span>
                {employee.teams.map((t: any) => (
                  t.isPrimary ? (
                    <Pill key={t.id} color={PURPLE}>{t.name} · Primary</Pill>
                  ) : (
                    <span key={t.id} className="inline-flex items-center h-[22px] px-2.5 rounded-[11px] border border-ds-line2 bg-ds-chip text-ds-t5 text-[10.5px] font-semibold whitespace-nowrap">
                      {t.name}
                    </span>
                  )
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Link
            href={`/employees/${id}/performance`}
            className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2"
          >
            <BarChart3 className="h-3.5 w-3.5" /> Performance
          </Link>
          {isAdminOrSuperAdmin && (
            <button
              onClick={handleDeleteEmployee}
              className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-[rgba(229,72,77,.4)] text-[color:var(--hx-FB7185)] text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-[rgba(229,72,77,.1)]"
            >
              <X className="h-3.5 w-3.5" /> Delete
            </button>
          )}
        </div>
      </div>

      {/* Quick Stats */}
      {profile && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3.5">
          <div className="rounded-[12px] border border-ds-line bg-ds-card p-4 min-w-0">
            <p className="text-[12px] text-ds-t5">Salary</p>
            <p className="mt-1.5 text-[20px] font-semibold tracking-[-.02em] text-ds-text truncate">{profile.salary ? formatCurrency(profile.salary) : "—"}</p>
          </div>
          <div className="rounded-[12px] border border-ds-line bg-ds-card p-4 min-w-0">
            <p className="text-[12px] text-ds-t5">Status</p>
            <div className="mt-2">
              <Pill color={employee.status === "ACTIVE" ? GREEN : employee.status === "ONBOARDING" ? AMBER : RED} dot>{formatStatus(employee.status)}</Pill>
            </div>
          </div>
          <div className="rounded-[12px] border border-ds-line bg-ds-card p-4 min-w-0">
            <p className="text-[12px] text-ds-t5">Total Incentives</p>
            <p className="mt-1.5 text-[20px] font-semibold tracking-[-.02em] text-ds-text truncate">{formatCurrency(incentives.reduce((s: number, i: any) => s + i.amount, 0))}</p>
          </div>
          <div className="rounded-[12px] border border-ds-line bg-ds-card p-4 min-w-0">
            <p className="text-[12px] text-ds-t5">Avg Review Rating</p>
            <p className="mt-1.5 text-[20px] font-semibold tracking-[-.02em] text-ds-text truncate">{reviews.length ? (reviews.reduce((s: number, r: any) => s + r.rating, 0) / reviews.length).toFixed(1) + "/5" : "—"}</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full w-fit overflow-x-auto" role="tablist" aria-label="Employee sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const on = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 h-9 px-4 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
                on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"
              }`}
            >
              <Icon size={15} />
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-gold"}`}>{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Profile Tab */}
      {activeTab === "profile" && (
        <div className="space-y-5">
          {/* Employee Form (edit basic info) */}
          <div className="max-w-2xl">
            <EmployeeForm employee={employee} roles={roles} profile={profile} onSaved={() => { mutateEmployee(); mutateProfile(); showSuccess("Employee updated."); }} />
          </div>

          {/* Role Management — admin/super-admin only */}
          {isAdminOrSuperAdmin && (
            <RoleManager employeeId={id as string} allRoles={roles} currentRoles={employee.roles ?? []} />
          )}

          {/* Job Description */}
          <div className={`${CARD} p-5 sm:p-6`}>
            <div className="flex items-center gap-3 mb-4">
              <span className={ICON_TILE}><Briefcase className="h-4 w-4" /></span>
              <h3 className={CARD_TITLE}>Job Description</h3>
            </div>
            <textarea
              value={jdForm}
              onChange={(e) => setJdForm(e.target.value)}
              rows={5}
              placeholder="Enter job description, responsibilities, and expectations..."
              className={`${inputClass} resize-none`}
            />
            <div className="mt-3 flex justify-end">
              <button onClick={saveJobDescription} disabled={savingJd} className={GOLD_BTN}>
                {savingJd ? "Saving..." : "Save Job Description"}
              </button>
            </div>
          </div>

          {/* Employee Submitted Data — editable by admin */}
          {profile && (
            <div className={`${CARD} p-5 sm:p-6 space-y-4`}>
              <div className="flex items-center justify-between gap-3">
                <h3 className={`${CARD_TITLE} flex items-center gap-3`}><span className={ICON_TILE}><CreditCard className="h-4 w-4" /></span> Employee Submitted Data</h3>
                {!isEditingProfile && (
                  <button onClick={startEditProfile} className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-[8px] border border-ds-line2 bg-ds-hover text-ds-t5 text-[12px] font-semibold transition-colors hover:border-[rgba(233,189,98,.55)] hover:text-ds-gold shrink-0">
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                )}
              </div>

              {isEditingProfile ? (
                <form onSubmit={saveProfileData} className="space-y-5">
                  <div>
                    <p className={SECTION_LABEL}>Bank Details</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {[
                        { key: "bankName", label: "Bank Name" },
                        { key: "bankAccountNumber", label: "Account Number" },
                        { key: "bankAccountHolderName", label: "Account Holder" },
                        { key: "bankBranch", label: "Branch" },
                        { key: "ifscCode", label: "IFSC Code" },
                      ].map(({ key, label }) => (
                        <div key={key} className="min-w-0">
                          <label className={FIELD_LABEL}>{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className={SECTION_LABEL}>ID Documents</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[{ key: "aadhaarNumber", label: "Aadhaar Number" }, { key: "panNumber", label: "PAN Number" }].map(({ key, label }) => (
                        <div key={key} className="min-w-0">
                          <label className={FIELD_LABEL}>{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className={FIELD_LABEL}>Mailing Address</label>
                    <textarea rows={2} className={inputClass + " resize-none"} value={profileEditForm.mailingAddress || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, mailingAddress: e.target.value })} placeholder="Full mailing address" />
                  </div>
                  <div>
                    <p className={SECTION_LABEL}>Emergency Contacts</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                      {[{ key: "familyContact1Name", label: "Contact 1 Name" }, { key: "familyContact1Relation", label: "Relation" }, { key: "familyContact1Phone", label: "Phone" }].map(({ key, label }) => (
                        <div key={key} className="min-w-0">
                          <label className={FIELD_LABEL}>{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {[{ key: "familyContact2Name", label: "Contact 2 Name" }, { key: "familyContact2Relation", label: "Relation" }, { key: "familyContact2Phone", label: "Phone" }].map(({ key, label }) => (
                        <div key={key} className="min-w-0">
                          <label className={FIELD_LABEL}>{label}</label>
                          <input className={inputClass} value={profileEditForm[key] || ""} onChange={(e) => setProfileEditForm({ ...profileEditForm, [key]: e.target.value })} placeholder={label} />
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2.5 pt-4 border-t border-[color:var(--hx-1A2C38)]">
                    <button type="submit" disabled={savingProfile} className={GOLD_BTN}>
                      <Check className="h-3.5 w-3.5" /> {savingProfile ? "Saving..." : "Save Changes"}
                    </button>
                    <button type="button" onClick={() => setIsEditingProfile(false)} className={GHOST_BTN}>
                      <X className="h-3.5 w-3.5" /> Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
                      <h4 className="text-[13.5px] font-semibold text-ds-text flex items-center gap-2 pt-2"><UsersIcon className="h-4 w-4 text-ds-t3" /> Emergency Contacts</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        <div className={`${CARD} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Task</th>
                  <th className={TH}>Priority</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Due Date</th>
                  <th className={TH}>Account</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 ? (
                  <tr><td colSpan={5} className="py-12 px-5 text-center text-ds-t3"><ListTodo className="h-8 w-8 mx-auto mb-2 opacity-40" />No tasks assigned</td></tr>
                ) : tasks.map((task: any) => (
                  <tr key={task.id} className={TR}>
                    <td className={TD}>
                      <p className="font-semibold text-ds-text">{task.title}</p>
                      {task.description && <p className="text-[11.5px] text-ds-t3 mt-0.5 line-clamp-1">{task.description}</p>}
                    </td>
                    <td className={TD}>
                      <Pill color={priorityColor(task.priority)}>{task.priority}</Pill>
                    </td>
                    <td className={TD}>
                      <Pill color={statusColor(task.status)} dot>{formatStatus(task.status)}</Pill>
                    </td>
                    <td className={`${TD} text-ds-t2 whitespace-nowrap`}>{task.dueDate ? new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}</td>
                    <td className={`${TD} text-ds-t2`}>{task.account?.handle || task.account?.displayName || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Accounts Tab */}
      {activeTab === "accounts" && (
        <div className={CARD}>
          {assignedAccounts.length === 0 ? (
            <div className="py-14 px-5 text-center text-ds-t3">
              <MonitorSmartphone className="h-9 w-9 mx-auto mb-3 opacity-40" />
              <p className="text-[13.5px] font-semibold text-ds-t2 mb-1">No accounts assigned</p>
              <p className="text-[12.5px]">Assign social media accounts from the <Link href="/accounts" className="text-ds-gold hover:text-ds-gold2 hover:underline">Accounts</Link> page.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 p-5">
              {assignedAccounts.map((a: any) => (
                <div key={a.id} className={MINI_CARD}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`${ICON_TILE} h-10 w-10 rounded-[11px]`}>
                      <PlatformIcon slug={a.account?.platform?.slug} className="h-5 w-5 text-ds-gold" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-semibold text-ds-text truncate">{a.account?.displayName || a.account?.handle}</p>
                      <p className="text-[11.5px] text-ds-t3 truncate">{a.account?.platform?.name} · @{a.account?.handle}</p>
                    </div>
                  </div>
                  <div className="space-y-1.5 text-[12px] text-ds-t3">
                    {a.account?.clientName && <p>Client: <span className={STRONG}>{a.account.clientName}</span></p>}
                    <p>Followers: <span className={STRONG}>{(a.account?.followerCount || 0).toLocaleString()}</span></p>
                    <p>Assigned: <span className={STRONG}>{new Date(a.assignedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></p>
                    {a.assigner && <p>By: <span className={STRONG}>{a.assigner.name}</span></p>}
                  </div>
                  {a.account?.profileUrl && (
                    <a href={a.account.profileUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] text-ds-gold hover:text-ds-gold2 font-semibold">
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
        <div className={`${CARD} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Type</th>
                  <th className={TH}>Filename</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Uploaded</th>
                  <th className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr><td colSpan={5} className="py-12 px-5 text-center text-ds-t3">No documents uploaded</td></tr>
                ) : docs.map((doc: any) => (
                  <tr key={doc.id} className={TR}>
                    <td className={`${TD} font-semibold text-ds-text`}>{doc.documentType}</td>
                    <td className={`${TD} text-ds-t5`}>{doc.fileName}</td>
                    <td className={TD}>
                      <Pill color={statusColor(doc.status)} dot>{formatStatus(doc.status)}</Pill>
                    </td>
                    <td className={`${TD} text-ds-t2 whitespace-nowrap`}>{new Date(doc.createdAt).toLocaleDateString()}</td>
                    <td className={TD}>
                      {doc.filePath && (
                        <a
                          href={doc.filePath.startsWith("http") ? doc.filePath : `${API_BASE}${doc.filePath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-[5px] h-[26px] px-2.5 rounded-[6px] bg-ds-hover border border-ds-line2 text-ds-t5 text-[11px] font-semibold transition-colors hover:border-[rgba(233,189,98,.55)] hover:text-ds-gold"
                        >
                          <Eye size={12} /> View
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
        <div className={`${CARD} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={THEAD_ROW}>
                  <th className={TH}>Date</th>
                  <th className={TH}>Hours</th>
                  <th className={TH}>Description</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {extraHours.length === 0 ? (
                  <tr><td colSpan={5} className="py-12 px-5 text-center text-ds-t3">No extra work hours logged</td></tr>
                ) : extraHours.map((eh: any) => (
                  <tr key={eh.id} className={TR}>
                    <td className={`${TD} font-semibold text-ds-text whitespace-nowrap`}>{new Date(eh.date).toLocaleDateString()}</td>
                    <td className={`${TD} text-ds-t5`}>{eh.hours}h</td>
                    <td className={`${TD} text-ds-t2 max-w-[200px] truncate`}>{eh.description || "—"}</td>
                    <td className={TD}>
                      <Pill color={statusColor(eh.status)} dot>{formatStatus(eh.status)}</Pill>
                    </td>
                    <td className={TD}>
                      {eh.status === "PENDING" && (
                        <div className="flex gap-2">
                          <button onClick={() => handleExtraHourAction(eh.id, "approve")} className="inline-flex items-center gap-1 h-[28px] px-3 rounded-full border border-[rgba(0,215,160,.35)] bg-[rgba(0,215,160,.1)] text-ds-teal text-[11.5px] font-semibold transition-colors hover:bg-[rgba(0,215,160,.18)]">
                            <Check size={13} /> Approve
                          </button>
                          <button onClick={() => handleExtraHourAction(eh.id, "reject")} className="inline-flex items-center gap-1 h-[28px] px-3 rounded-full border border-[rgba(229,72,77,.35)] bg-[rgba(229,72,77,.1)] text-[color:var(--hx-FB7185)] text-[11.5px] font-semibold transition-colors hover:bg-[rgba(229,72,77,.18)]">
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
          <form onSubmit={handleAddIncentive} className={`${CARD} p-5`}>
            <p className={`${CARD_TITLE} mb-3.5 flex items-center gap-2.5`}><span className={`${ICON_TILE} h-8 w-8 rounded-[9px]`}><Plus size={15} /></span> Award Incentive</p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input type="number" placeholder="Amount (₹)" value={incentiveForm.amount} onChange={(e) => setIncentiveForm({ ...incentiveForm, amount: e.target.value })} required className={inputClass} />
              <input type="text" placeholder="Reason" value={incentiveForm.reason} onChange={(e) => setIncentiveForm({ ...incentiveForm, reason: e.target.value })} required className={inputClass} />
              <input type="number" placeholder="Month (1-12)" min="1" max="12" value={incentiveForm.month} onChange={(e) => setIncentiveForm({ ...incentiveForm, month: e.target.value })} className={inputClass} />
              <input type="number" placeholder="Year" value={incentiveForm.year} onChange={(e) => setIncentiveForm({ ...incentiveForm, year: e.target.value })} className={inputClass} />
            </div>
            <div className="mt-3.5 flex justify-end">
              <button type="submit" disabled={addingIncentive} className={GOLD_BTN}>
                {addingIncentive ? "Adding..." : "Award Incentive"}
              </button>
            </div>
          </form>

          <div className={`${CARD} overflow-hidden`}>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className={THEAD_ROW}>
                    <th className={TH}>Amount</th>
                    <th className={TH}>Reason</th>
                    <th className={TH}>Period</th>
                    <th className={TH}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {incentives.length === 0 ? (
                    <tr><td colSpan={4} className="py-12 px-5 text-center text-ds-t3">No incentives awarded</td></tr>
                  ) : incentives.map((inc: any) => (
                    <tr key={inc.id} className={TR}>
                      <td className={`${TD} font-semibold text-ds-gold whitespace-nowrap`}>{formatCurrency(inc.amount)}</td>
                      <td className={`${TD} text-ds-t5`}>{inc.reason}</td>
                      <td className={`${TD} text-ds-t2`}>{inc.month && inc.year ? `${inc.month}/${inc.year}` : "—"}</td>
                      <td className={`${TD} text-ds-t2 whitespace-nowrap`}>{new Date(inc.createdAt).toLocaleDateString()}</td>
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
          <form onSubmit={handleAddReview} className={`${CARD} p-5`}>
            <p className={`${CARD_TITLE} mb-3.5 flex items-center gap-2.5`}><span className={`${ICON_TILE} h-8 w-8 rounded-[9px]`}><Plus size={15} /></span> Add Performance Review</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input type="text" placeholder="Review Period (e.g., Q1 2026)" value={reviewForm.period} onChange={(e) => setReviewForm({ ...reviewForm, period: e.target.value })} required className={inputClass} />
              <select value={reviewForm.rating} onChange={(e) => setReviewForm({ ...reviewForm, rating: e.target.value })} className={`${inputClass} cursor-pointer`}>
                <option value="1">1 - Needs Improvement</option>
                <option value="2">2 - Below Expectations</option>
                <option value="3">3 - Meets Expectations</option>
                <option value="4">4 - Exceeds Expectations</option>
                <option value="5">5 - Outstanding</option>
              </select>
              <textarea placeholder="Strengths..." value={reviewForm.strengths} onChange={(e) => setReviewForm({ ...reviewForm, strengths: e.target.value })} rows={2} className={`${inputClass} resize-y`} />
              <textarea placeholder="Areas for Improvement..." value={reviewForm.improvements} onChange={(e) => setReviewForm({ ...reviewForm, improvements: e.target.value })} rows={2} className={`${inputClass} resize-y`} />
              <textarea placeholder="Comments..." value={reviewForm.comments} onChange={(e) => setReviewForm({ ...reviewForm, comments: e.target.value })} rows={2} className={`${inputClass} resize-y`} />
              <textarea placeholder="Goals for Next Period..." value={reviewForm.goals} onChange={(e) => setReviewForm({ ...reviewForm, goals: e.target.value })} rows={2} className={`${inputClass} resize-y`} />
            </div>
            <div className="mt-3.5 flex justify-end">
              <button type="submit" disabled={addingReview} className={GOLD_BTN}>
                {addingReview ? "Submitting..." : "Submit Review"}
              </button>
            </div>
          </form>

          <div className="space-y-3.5">
            {reviews.length === 0 ? (
              <div className={`${CARD} py-12 px-5 text-center text-ds-t3 text-[13px]`}>No reviews yet</div>
            ) : reviews.map((review: any) => (
              <div key={review.id} className={`${CARD} p-5`}>
                <div className="flex items-center justify-between gap-3 mb-3.5 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-[14.5px] font-semibold text-ds-text">{review.period}</p>
                    <p className="text-[11.5px] text-ds-t3 mt-0.5">by {review.reviewer?.name ?? "Unknown Reviewer"} · {new Date(review.createdAt).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    {[1,2,3,4,5].map(s => (
                      <div key={s} className={`h-2.5 w-2.5 rounded-full ${s <= review.rating ? "bg-ds-gold" : "bg-ds-line2"}`} />
                    ))}
                    <span className="ml-2 text-[13px] font-semibold text-ds-text">{review.rating}/5</span>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px] text-ds-t5">
                  {review.strengths && <div><p className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-1">Strengths</p><p>{review.strengths}</p></div>}
                  {review.improvements && <div><p className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-1">Improvements</p><p>{review.improvements}</p></div>}
                  {review.comments && <div><p className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-1">Comments</p><p>{review.comments}</p></div>}
                  {review.goals && <div><p className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-1">Goals</p><p>{review.goals}</p></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Devices Tab */}
      {activeTab === "devices" && (
        <div className={CARD}>
          {employeeDevices.length === 0 ? (
            <div className="py-14 px-5 text-center text-ds-t3">
              <Laptop className="h-9 w-9 mx-auto mb-3 opacity-40" />
              <p className="text-[13.5px] font-semibold text-ds-t2 mb-1">No devices assigned</p>
              <p className="text-[12.5px]">Assign devices from the <Link href="/devices" className="text-ds-gold hover:text-ds-gold2 hover:underline">Devices</Link> page.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 p-5">
              {employeeDevices.map((d: any) => {
                const Icon = d.type === "PHONE" || d.type === "TABLET" ? Smartphone : d.type === "MONITOR" ? Monitor : d.type === "HEADSET" ? Headphones : Laptop;
                return (
                  <div key={d.id} className={MINI_CARD}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`${ICON_TILE} h-10 w-10 rounded-[11px]`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-ds-text truncate">{d.brand} {d.model}</p>
                        <p className="text-[11px] font-semibold tracking-[.08em] text-ds-t3">{d.type}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5 text-[12px] text-ds-t3">
                      <p>Condition: <span className={STRONG}>{d.condition}</span></p>
                      {d.serialNumber && <p>S/N: <span className={`${STRONG} font-mono`}>{d.serialNumber}</span></p>}
                      {d.assetTag && <p>Tag: <span className={`${STRONG} font-mono`}>{d.assetTag}</span></p>}
                      <p>Assigned: <span className={STRONG}>{new Date(d.assignedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></p>
                      {d.notes && <p className="text-ds-t3 italic mt-1">{d.notes}</p>}
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
    <div className="min-w-0">
      <p className={FIELD_LABEL}>{label}</p>
      <p className="text-[13px] text-ds-t5 bg-ds-inset rounded-[10px] px-3 py-2.5 border border-ds-line2 break-words">{value || "—"}</p>
    </div>
  );
}

function RoleManager({ employeeId, allRoles, currentRoles }: { employeeId: string; allRoles: any[]; currentRoles: any[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentRoles.map((r: any) => r.role?.id ?? r.id)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  const noneSelected = selected.size === 0;

  function toggle(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) {
        if (next.size === 1) return prev; // block removing the last role
        next.delete(roleId);
      } else {
        next.add(roleId);
      }
      return next;
    });
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setRoleError(null);
    try {
      await apiFetch(`/admin/users/${employeeId}/roles`, {
        method: "PUT",
        body: JSON.stringify({ roleIds: Array.from(selected) }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setRoleError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className={`${CARD} p-5 sm:p-6 max-w-2xl`}>
      <div className="flex items-center gap-3 mb-3">
        <span className={ICON_TILE}><UsersIcon className="h-4 w-4" /></span>
        <h3 className={CARD_TITLE}>Role Assignment</h3>
      </div>
      <p className="text-[12px] text-ds-t3 mb-4">Roles control what this employee can see and do. Every employee must have at least one role.</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {allRoles.map((role: any) => {
          const active = selected.has(role.id);
          const isLast = active && selected.size === 1;
          return (
            <button
              key={role.id}
              onClick={() => toggle(role.id)}
              title={isLast ? "Cannot remove the only role" : undefined}
              aria-pressed={active}
              className={`inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full text-[12px] font-semibold border transition-colors ${
                active
                  ? isLast
                    ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-gold opacity-60 cursor-not-allowed"
                    : "border-ds-gold/55 bg-ds-gold/[.14] text-ds-gold"
                  : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text hover:border-ds-line4"
              }`}
            >
              {active ? <Check size={11} /> : <Plus size={11} />}
              {role.name}
            </button>
          );
        })}
      </div>
      {noneSelected && (
        <p className="text-[12px] text-[color:var(--hx-FB7185)] mb-3">At least one role is required.</p>
      )}
      {roleError && (
        <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] rounded-[10px] px-3 py-2 mb-3">{roleError}</p>
      )}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || noneSelected}
          className={GOLD_BTN}
        >
          {saving ? "Saving..." : "Save Roles"}
        </button>
        {saved && <span className="text-[12px] text-ds-teal font-semibold flex items-center gap-1"><Check size={12} /> Roles updated</span>}
      </div>
    </div>
  );
}
