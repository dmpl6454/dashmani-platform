"use client";
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { ScrollText, Check, Shield, Clock, Users, AlertTriangle } from "lucide-react";

export default function SOPPage() {
  const [accepted, setAccepted] = useState(false);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    apiFetch<any>("/hr/sop-status")
      .then((res) => {
        setAccepted(res.data?.accepted || false);
        setAcceptedAt(res.data?.acceptedAt || null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
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

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;

  const sections = [
    {
      icon: Clock,
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
      icon: Shield,
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
      icon: Users,
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
      icon: AlertTriangle,
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
      icon: ScrollText,
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

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif flex items-center gap-3">
            <ScrollText className="h-8 w-8 text-[#F5D547]" /> Company SOPs & Terms
          </h1>
          <p className="text-sm text-[#888] mt-1">Standard Operating Procedures and Terms of Employment</p>
        </div>
        {accepted && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 px-4 py-2 rounded-full text-sm font-medium">
            <Check className="h-4 w-4" /> Accepted {acceptedAt ? `on ${new Date(acceptedAt).toLocaleDateString("en-IN")}` : ""}
          </div>
        )}
      </div>

      {/* Company Name Header */}
      <div className="bg-gradient-to-r from-[#1A1A1A] to-[#333] rounded-2xl p-6 text-white">
        <p className="text-lg font-serif">Dashmani Media Private Limited — Digital Sukoon</p>
        <p className="text-sm text-white/60 mt-1">These SOPs apply to all employees and must be acknowledged upon joining.</p>
      </div>

      {/* Sections */}
      {sections.map((section, idx) => {
        const Icon = section.icon;
        return (
          <div key={idx} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
            <h2 className="text-lg font-semibold text-[#1A1A1A] flex items-center gap-2 mb-4">
              <Icon className="h-5 w-5 text-[#B8960C]" /> {section.title}
            </h2>
            <ul className="space-y-2.5">
              {section.items.map((item, i) => (
                <li key={i} className="flex gap-3 text-sm text-[#555]">
                  <span className="shrink-0 mt-1 h-1.5 w-1.5 rounded-full bg-[#F5D547]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {/* Accept Section */}
      {!accepted && (
        <div className="bg-[#FFF3C4] border border-[#F5D547] rounded-2xl p-6">
          <h3 className="font-semibold text-[#1A1A1A] mb-3">Acknowledgement Required</h3>
          <label className="flex items-start gap-3 cursor-pointer mb-4">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-[#F5D547] focus:ring-[#F5D547]" />
            <span className="text-sm text-[#1A1A1A]">
              I have read and understood the Standard Operating Procedures and Terms of Employment of Dashmani Media Pvt. Ltd. (Digital Sukoon). I agree to abide by these policies during my employment.
            </span>
          </label>
          <button onClick={handleAccept} disabled={!checked || accepting} className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
            {accepting ? "Accepting..." : "I Accept the Terms & SOPs"}
          </button>
        </div>
      )}
    </div>
  );
}
