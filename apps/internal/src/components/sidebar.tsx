"use client";
// Nav DATA for the staff portal. The rail itself is components/ds/ds-sidebar.tsx (rendered by
// app/layout.tsx); the old Sidebar() that lived here was never rendered and was removed 2026-11-06.
import {
  LayoutDashboard, Users, Building2, Clock, CheckSquare, Globe, BarChart3,
  Briefcase, FolderOpen, FileEdit, TrendingUp, FileText, UserPlus, Megaphone,
  Wallet, FileSignature, Calendar, BriefcaseBusiness, Bug, Sparkles, Laptop,
  GraduationCap, AlertCircle, Settings, CalendarOff, ClipboardList, Search, Receipt,
  ShoppingBag, BadgeCheck, Banknote,
} from "lucide-react";

/* ── Primary nav — grouped by what the person is doing. A `group` label starts a section;
   the rows under it carry null. Regrouped 2026-11-06: "Analytics" used to hold ten rows
   including Leave, Approvals, Expense Claims, Devices, Complaints and Bug Reports. ── */
export const primaryNav = [
  { href: "/dashboard",     label: "Dashboard",        icon: LayoutDashboard, group: null },
  { href: "/employees",     label: "Employees",        icon: Users,           group: "People",    badgeKey: "pendingEmployees" as const },
  { href: "/teams",         label: "Teams",            icon: Building2,       group: null },
  { href: "/attendance",    label: "Attendance",       icon: Clock,           group: null },
  { href: "/leave",         label: "Leave",            icon: CalendarOff,     group: null },
  { href: "/approvals",     label: "Approvals",        icon: CheckSquare,     group: null },
  { href: "/tasks",         label: "Tasks",            icon: CheckSquare,     group: "Work" },
  { href: "/content",       label: "Content",          icon: FileEdit,        group: null },
  { href: "/daily-reports", label: "Daily Updates",    icon: ClipboardList,   group: null },
  { href: "/workload",      label: "Workload Matrix",  icon: BarChart3,       group: null },
  { href: "/accounts",      label: "Accounts",         icon: Globe,           group: "Channels" },
  { href: "/accounts/growth", label: "Account Growth", icon: TrendingUp,      group: null },
  { href: "/reports",       label: "Link Reports",     icon: FileText,        group: null },
  { href: "/reports/link-search", label: "Link Search", icon: Search,         group: null },
  { href: "/analytics",     label: "Analytics",        icon: TrendingUp,      group: null },
  { href: "/clients",       label: "Clients",          icon: Briefcase,       group: "Business" },
  { href: "/projects",      label: "Projects",         icon: FolderOpen,      group: null },
  { href: "/campaigns",     label: "Campaign Bookings", icon: ShoppingBag,    group: null },
  { href: "/creators",      label: "Creators",         icon: BadgeCheck,      group: null },
  { href: "/expenses",      label: "Expense Claims",   icon: Wallet,          group: "Workplace" },
  { href: "/devices",       label: "Assigned Devices", icon: Laptop,          group: null },
  { href: "/complaints",    label: "Complaints",       icon: AlertCircle,     group: null },
  { href: "/bug-reports",   label: "Bug Reports",      icon: Bug,             group: null },
  { href: "/ai-assistant",  label: "AI Assistant",     icon: Sparkles,        group: "Tools" },
  { href: "/api-costs",     label: "API Costs",        icon: Receipt,         group: null },
  { href: "/announcements", label: "Announcements",    icon: Megaphone,       group: null },
];

/* ── More section items (3-col grid) ── */
export const moreNav = [
  { href: "/salary-slips",  label: "Salary Slips",  icon: Banknote        },
  { href: "/offer-letters", label: "Offer Letters", icon: FileSignature   },
  { href: "/holidays",      label: "Holiday Calendar", icon: Calendar      },
  { href: "/jobs",          label: "Job Listings",  icon: BriefcaseBusiness },
  { href: "/auto-teams",    label: "Auto Teams",    icon: UserPlus        },
  { href: "/internships",   label: "Internships",   icon: GraduationCap   },
  { href: "/settings",      label: "Settings",      icon: Settings        },
];

/* ── HR-only portal nav — what an HR Manager (without Admin) sees. lib/roles.ts
   holds the matching route allowlist; keep the two in step. ── */
export type NavItem = {
  href: string; label: string; icon: typeof Users; group: string | null; badgeKey?: "pendingEmployees";
};

export const hrNav: NavItem[] = [
  { href: "/hr",            label: "HR Home",          icon: LayoutDashboard,   group: null },
  { href: "/employees",     label: "Employees",        icon: Users,             group: "People" },
  { href: "/attendance",    label: "Attendance",       icon: Clock,             group: null },
  { href: "/leave",         label: "Leave",            icon: CalendarOff,       group: null },
  { href: "/approvals",     label: "Approvals",        icon: CheckSquare,       group: null },
  { href: "/holidays",      label: "Holiday Calendar", icon: Calendar,          group: null },
  { href: "/salary-slips",  label: "Salary Slips",     icon: Banknote,          group: "Payroll & Letters" },
  { href: "/offer-letters", label: "Offer Letters",    icon: FileSignature,     group: null },
  { href: "/ai-assistant",  label: "AI Assistant",     icon: Sparkles,          group: null },
  { href: "/jobs",          label: "Job Listings",     icon: BriefcaseBusiness, group: "Hiring" },
  { href: "/internships",   label: "Internships",      icon: GraduationCap,     group: null },
  { href: "/expenses",      label: "Expense Claims",   icon: Wallet,            group: "Workplace" },
  { href: "/devices",       label: "Assigned Devices", icon: Laptop,            group: null },
  { href: "/complaints",    label: "Complaints",       icon: AlertCircle,       group: null },
  { href: "/announcements", label: "Announcements",    icon: Megaphone,         group: null },
  { href: "/settings",      label: "Settings",         icon: Settings,          group: "Account" },
];
