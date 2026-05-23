"use client";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { Topstrip } from "@/components/portal-shell";
import { ScrollText, Check, Shield, Clock, Users, AlertTriangle } from "lucide-react";

const ICON_MAP: Record<string, any> = {
  Clock,
  Shield,
  Users,
  AlertTriangle,
  ScrollText,
};

const DEFAULT_SECTIONS = [
  {
    icon: "Clock",
    title: "Working Hours & Attendance",
    items: [
      "Standard working hours are 10:00 AM to 7:00 PM, Monday to Saturday.",
      "All employees must mark attendance daily through the HR portal.",
      "Late arrivals of more than 15 minutes will be recorded and may affect monthly reviews.",
      "Work from Home (WFH) must be requested and approved in advance through the portal.",
      "Compensatory offs (Comp-Off) must be approved by your reporting manager.",
    ],
  },
  {
    icon: "Shield",
    title: "Code of Conduct",
    items: [
      "Maintain professional behavior with colleagues, clients, and partners at all times.",
      "Respect confidentiality of client data, company strategies, and proprietary information.",
      "Do not share login credentials, client access, or internal tools with unauthorized persons.",
      "Personal use of company devices should be minimal and not interfere with work responsibilities.",
      "Harassment, discrimination, or bullying of any kind will not be tolerated and may result in immediate termination.",
    ],
  },
  {
    icon: "Users",
    title: "Leave & Time-Off Policy",
    items: [
      "Employees are entitled to 12 paid leaves per year (1 per month).",
      "Sick leave requires notification before 10:00 AM on the day of absence.",
      "Leave applications must be submitted at least 3 days in advance for planned leaves.",
      "Unapproved absence for 3 consecutive days will be considered abandonment of duty.",
      "National holidays as declared by the company will be observed.",
    ],
  },
  {
    icon: "AlertTriangle",
    title: "Data & Social Media Policy",
    items: [
      "All social media accounts managed are property of the clients and the company.",
      "Never share client social media credentials outside of authorized tools.",
      "Content must be approved before publishing on any client account.",
      "Personal opinions must not be expressed through client or company accounts.",
      "Data breaches or unauthorized access must be reported immediately to your manager and admin.",
    ],
  },
  {
    icon: "ScrollText",
    title: "Termination & Exit Policy",
    items: [
      "A minimum notice period of 30 days is required for resignation.",
      "All company assets (laptops, phones, IDs) must be returned before the last working day.",
      "Exit interviews will be conducted by HR.",
      "Pending salary and dues will be cleared within 15 days of the last working day.",
      "Non-compete and NDA clauses in the employment contract remain valid after exit.",
    ],
  },
];

export default function SOPPage() {
  const [accepted, setAccepted] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [checked, setChecked] = useState(false);
  const [sections, setSections] = useState(DEFAULT_SECTIONS);

  useEffect(() => {
    Promise.all([
      apiFetch<any>("/hr/sop-status").catch(() => null),
      apiFetch<any>("/hr/sop-content").catch(() => null),
    ]).then(([statusRes, contentRes]) => {
      if (statusRes?.data) {
        setAccepted(statusRes.data.accepted || false);
        setAcceptedAt(statusRes.data.acceptedAt || null);
      }
      if (contentRes?.data?.sections) {
        setSections(contentRes.data.sections);
      }
    }).finally(() => setLoading(false));
  }, []);

  async function handleAccept() {
    setAccepting(true);
    try {
      await apiFetch("/hr/accept-sop", { method: "POST" });
      setAccepted(true);
      setAcceptedAt(new Date().toISOString());
    } catch (e: any) { alert(e.message); }
    setAccepting(false);
  }

  if (loading) {
    return (
      <>
        <Topstrip title="Company SOPs & Terms" sub="Standard Operating Procedures and Terms of Employment" />
        <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] flex justify-center pt-16">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-indigo" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title="Company SOPs & Terms"
        sub="Standard Operating Procedures and Terms of Employment"
        right={
          accepted ? (
            <div className="inline-flex h-8 items-center gap-2 bg-success-bg border border-success/20 text-success px-4 rounded-full text-[12px] font-semibold">
              <Check className="h-3.5 w-3.5" />
              Accepted {acceptedAt ? `on ${new Date(acceptedAt).toLocaleDateString("en-IN")}` : ""}
            </div>
          ) : undefined
        }
      />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-4">

        {/* Company Header */}
        <div className="v3-card overflow-hidden">
          <div className="bg-ink px-6 py-5">
            <p className="text-[15px] font-display text-white">Dashmani Media Private Limited — Digital Sukoon</p>
            <p className="text-[12px] text-white/50 mt-1 font-medium">These SOPs apply to all employees and must be acknowledged upon joining.</p>
          </div>
        </div>

        {/* Sections */}
        {sections.map((section, idx) => {
          const Icon = ICON_MAP[section.icon] ?? ScrollText;
          return (
            <div key={idx} className="v3-card">
              <div className="px-5 h-12 flex items-center gap-2.5" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <Icon className="h-4 w-4 text-indigo" />
                <span className="text-[13px] font-semibold text-ink">{section.title}</span>
              </div>
              <ul className="px-5 py-4 space-y-2.5">
                {section.items.map((item: string, i: number) => (
                  <li key={i} className="flex gap-3 text-[13px] text-ink-3 leading-relaxed">
                    <span className="shrink-0 mt-2 h-1.5 w-1.5 rounded-full bg-indigo" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {/* Accept Section */}
        {!accepted && (
          <div className="v3-card border-2 border-attention/30 bg-attention-bg">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Acknowledgement Required</span>
            </div>
            <div className="p-5">
              <label className="flex items-start gap-3 cursor-pointer mb-5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-ink/20 accent-indigo"
                />
                <span className="text-[13px] text-ink leading-relaxed">
                  I have read and understood the Standard Operating Procedures and Terms of Employment of Dashmani Media Pvt. Ltd. (Digital Sukoon). I agree to abide by these policies during my employment.
                </span>
              </label>
              <button
                onClick={handleAccept}
                disabled={!checked || accepting}
                className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50"
              >
                {accepting ? "Accepting..." : "I Accept the Terms & SOPs"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
