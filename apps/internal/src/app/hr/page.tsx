"use client";
// HR home — where an HR Manager (without Admin) lands after sign-in (lib/roles.ts).
// Every figure comes from an endpoint the HR Manager role can read; a card whose
// request fails shows "—", never a 0 it did not load.
import Link from "next/link";
import useSWR from "swr";
import {
  Users, CalendarOff, FileCheck2, UserPlus, Wallet, AlertCircle, Banknote,
  FileSignature, BriefcaseBusiness, GraduationCap, Calendar, Megaphone, Clock, Sparkles,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const fetcher = (url: string) => apiFetch<any>(url);
const opts = { revalidateOnFocus: false, dedupingInterval: 60_000 };

/** Number of rows in a list response, or null when it has not loaded. */
function countOf(res: any): number | null {
  const d = res?.data;
  if (Array.isArray(d)) return d.length;
  if (Array.isArray(d?.items)) return d.items.length;
  return null;
}

function useCount(key: string, filter?: (row: any) => boolean) {
  const { data, error, isLoading } = useSWR(key, fetcher, opts);
  if (error || isLoading) return null;
  if (filter && Array.isArray(data?.data)) return data.data.filter(filter).length;
  return countOf(data);
}

export default function HrHomePage() {
  usePageTitle("HR Home");
  const { user } = useAuth();
  const firstName = (user?.name ?? "").split(" ")[0];

  const { data: empData, error: empError } = useSWR("/employees?limit=1&status=ACTIVE", fetcher, opts);
  const activeEmployees: number | null = empError ? null : (empData?.meta?.total ?? null);

  const pendingLeave = useCount("/admin/leave-requests?status=PENDING");
  const pendingDocs = useCount("/admin/documents/pending");
  const pendingSignups = useCount("/admin/employees/pending");
  const pendingExpenses = useCount("/admin/expenses?status=PENDING");
  const openComplaints = useCount("/admin/complaints", (c) => c.status === "OPEN" || c.status === "IN_REVIEW");

  const needsAction = [
    { label: "Leave requests", value: pendingLeave, href: "/leave", icon: CalendarOff, note: "waiting for approval" },
    { label: "Documents", value: pendingDocs, href: "/approvals", icon: FileCheck2, note: "waiting for review" },
    { label: "New sign-ups", value: pendingSignups, href: "/employees/pending", icon: UserPlus, note: "waiting to be activated" },
    { label: "Expense claims", value: pendingExpenses, href: "/expenses", icon: Wallet, note: "waiting for approval" },
    { label: "Complaints", value: openComplaints, href: "/complaints", icon: AlertCircle, note: "open or in review" },
  ];

  const shortcuts = [
    { label: "Employees", href: "/employees", icon: Users },
    { label: "Attendance", href: "/attendance", icon: Clock },
    { label: "Salary Slips", href: "/salary-slips", icon: Banknote },
    { label: "Offer Letters", href: "/offer-letters", icon: FileSignature },
    { label: "AI Letters & Contracts", href: "/ai-assistant", icon: Sparkles },
    { label: "Job Listings", href: "/jobs", icon: BriefcaseBusiness },
    { label: "Internships", href: "/internships", icon: GraduationCap },
    { label: "Holiday Calendar", href: "/holidays", icon: Calendar },
    { label: "Announcements", href: "/announcements", icon: Megaphone },
  ];

  return (
    <div className="pb-6">
      <section className="pt-[26px] pb-5">
        <p className="text-[10.5px] font-semibold tracking-[.14em] uppercase text-ds-gold mb-1.5">HR Portal</p>
        <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] text-ds-text">
          Welcome{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">
          {activeEmployees == null ? "People, attendance, leave, payroll and hiring." : `${activeEmployees} active employees · people, attendance, leave, payroll and hiring.`}
        </p>
      </section>

      <h2 className="m-0 mb-2.5 text-[12px] font-semibold tracking-[.1em] uppercase text-ds-t3">Needs your action</h2>
      <div className="grid gap-2.5 sm:gap-3 grid-cols-1 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {needsAction.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.label}
              href={c.href}
              className="flex gap-3 p-3.5 min-w-0 rounded-[6px] bg-ds-card border border-ds-line text-ds-text transition-colors hover:border-ds-line3"
            >
              <span className="h-10 w-10 rounded-[9px] shrink-0 grid place-items-center bg-ds-gold/[.12]">
                <Icon className="h-[18px] w-[18px] text-ds-gold" strokeWidth={1.8} />
              </span>
              <span className="flex flex-col min-w-0">
                <span className="text-[11.5px] text-ds-t2 truncate">{c.label}</span>
                <span className="text-[22px] font-semibold leading-[1.15]">{c.value == null ? "—" : c.value}</span>
                <span className="text-[10px] text-ds-t3 truncate">{c.value == null ? "couldn't load" : c.note}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <h2 className="m-0 mt-6 mb-2.5 text-[12px] font-semibold tracking-[.1em] uppercase text-ds-t3">HR tools</h2>
      <div className="grid gap-2.5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {shortcuts.map((s) => {
          const Icon = s.icon;
          return (
            <Link
              key={s.href}
              href={s.href}
              className="flex items-center gap-2.5 px-3 py-3 min-w-0 rounded-[6px] bg-ds-card border border-ds-line text-ds-text text-[12.5px] font-medium transition-colors hover:border-ds-line3"
            >
              <Icon className="h-4 w-4 shrink-0 text-ds-t2" strokeWidth={1.8} />
              <span className="truncate">{s.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
