"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  IndianRupee,
} from "lucide-react";

interface SalarySlip {
  id: string;
  month: number;
  year: number;
  basicSalary: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherEarnings: number;
  pf: number;
  esi: number;
  tax: number;
  otherDeductions: number;
  netSalary: number;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  remarks?: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const statusConfig: Record<
  string,
  { label: string; bg: string; text: string; dot: string }
> = {
  DRAFT: {
    label: "Draft",
    bg: "bg-gray-100",
    text: "text-gray-700",
    dot: "bg-gray-400",
  },
  PENDING_APPROVAL: {
    label: "Pending",
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    dot: "bg-yellow-400",
  },
  APPROVED: {
    label: "Approved",
    bg: "bg-green-50",
    text: "text-green-700",
    dot: "bg-green-500",
  },
  REJECTED: {
    label: "Rejected",
    bg: "bg-red-50",
    text: "text-red-700",
    dot: "bg-red-500",
  },
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function SalarySlipsPage() {
  const { data, error, isLoading } = useSWR<SalarySlip[]>(
    "/hr/salary-slips",
    apiFetch
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const handleDownload = (slip: SalarySlip) => {
    // Open a print-friendly view of the salary slip
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<html><head><title>Salary Slip - ${MONTHS[slip.month - 1]} ${slip.year}</title>
      <style>body{font-family:sans-serif;padding:40px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f5f5f5}.right{text-align:right}h1{font-size:20px}@media print{body{padding:20px}}</style></head><body>
      <h1>Digital Sukoon - Salary Slip</h1><p>${MONTHS[slip.month - 1]} ${slip.year}</p>
      <table><tr><th>Earnings</th><th class="right">Amount</th></tr>
      <tr><td>Basic Salary</td><td class="right">₹${slip.basicSalary?.toLocaleString("en-IN")}</td></tr>
      <tr><td>HRA</td><td class="right">₹${slip.hra?.toLocaleString("en-IN")}</td></tr>
      <tr><td>Conveyance</td><td class="right">₹${slip.conveyance?.toLocaleString("en-IN")}</td></tr>
      <tr><td>Medical</td><td class="right">₹${slip.medicalAllowance?.toLocaleString("en-IN")}</td></tr>
      <tr><td>Special</td><td class="right">₹${slip.specialAllowance?.toLocaleString("en-IN")}</td></tr>
      <tr><th>Deductions</th><th class="right">Amount</th></tr>
      <tr><td>PF</td><td class="right">₹${slip.pf?.toLocaleString("en-IN")}</td></tr>
      <tr><td>ESI</td><td class="right">₹${slip.esi?.toLocaleString("en-IN")}</td></tr>
      <tr><td>Tax</td><td class="right">₹${slip.tax?.toLocaleString("en-IN")}</td></tr>
      <tr><th>Net Salary</th><th class="right">₹${slip.netSalary?.toLocaleString("en-IN")}</th></tr></table>
      <p style="margin-top:20px;color:#888">Status: ${slip.status}</p></body></html>`);
    w.document.close();
    w.print();
  };

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">
          Salary Slips
        </h1>
        <p className="text-sm text-[#888] mt-1">
          View and download your monthly salary slips
        </p>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 border-2 border-[#F5D547] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-2xl p-5 text-sm">
          Failed to load salary slips. Please try again later.
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && (!data || data.length === 0) && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-12 text-center">
          <div className="mx-auto w-16 h-16 bg-[#FEFCF7] rounded-full flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-[#C4B89C]" />
          </div>
          <h3 className="text-lg font-semibold text-[#1A1A1A] mb-1">
            No salary slips yet
          </h3>
          <p className="text-sm text-[#888]">
            Your salary slips will appear here once they are generated.
          </p>
        </div>
      )}

      {/* Salary Slips List */}
      {data && data.length > 0 && (
        <div className="space-y-4">
          {data.map((slip) => {
            const expanded = expandedId === slip.id;
            const status = statusConfig[slip.status] ?? statusConfig.DRAFT;

            return (
              <div
                key={slip.id}
                className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] overflow-hidden transition-all"
              >
                {/* Summary Row */}
                <div
                  className="flex items-center justify-between p-5 cursor-pointer hover:bg-[#FEFCF7] transition-colors"
                  onClick={() => toggleExpand(slip.id)}
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0] flex items-center justify-center shrink-0">
                      <IndianRupee className="w-5 h-5 text-[#C4B89C]" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-[#1A1A1A] text-sm">
                        {MONTHS[slip.month - 1]} {slip.year}
                      </p>
                      <p className="text-xs text-[#888] mt-0.5">
                        Basic: {formatCurrency(slip.basicSalary)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right hidden sm:block">
                      <p className="text-xs text-[#888]">Net Salary</p>
                      <p className="font-semibold text-[#1A1A1A] text-sm">
                        {formatCurrency(slip.netSalary)}
                      </p>
                    </div>

                    <span
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${status.bg} ${status.text}`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${status.dot}`}
                      />
                      {status.label}
                    </span>

                    {slip.status === "APPROVED" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(slip);
                        }}
                        className="p-2 rounded-lg hover:bg-[#F5D547]/10 text-[#1A1A1A] transition-colors"
                        title="Download"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    )}

                    <div className="text-[#888]">
                      {expanded ? (
                        <ChevronUp className="w-4 h-4" />
                      ) : (
                        <ChevronDown className="w-4 h-4" />
                      )}
                    </div>
                  </div>
                </div>

                {/* Expanded Breakdown */}
                {expanded && (
                  <div className="border-t border-[#E8E0D0] bg-[#FEFCF7] p-5">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {/* Earnings */}
                      <div>
                        <h4 className="text-xs font-semibold text-[#888] uppercase tracking-wider mb-3">
                          Earnings
                        </h4>
                        <div className="space-y-2">
                          <Row
                            label="Basic Salary"
                            value={slip.basicSalary}
                          />
                          <Row
                            label="House Rent Allowance"
                            value={slip.hra}
                          />
                          <Row
                            label="Conveyance Allowance"
                            value={slip.conveyance}
                          />
                          <Row
                            label="Medical Allowance"
                            value={slip.medicalAllowance}
                          />
                          <Row
                            label="Special Allowance"
                            value={slip.specialAllowance}
                          />
                          {slip.otherEarnings > 0 && (
                            <Row
                              label="Other Earnings"
                              value={slip.otherEarnings}
                            />
                          )}
                          <div className="border-t border-[#E8E0D0] pt-2 mt-2">
                            <Row
                              label="Gross Salary"
                              value={slip.basicSalary + slip.hra + slip.conveyance + slip.medicalAllowance + slip.specialAllowance + slip.otherEarnings}
                              bold
                            />
                          </div>
                        </div>
                      </div>

                      {/* Deductions */}
                      <div>
                        <h4 className="text-xs font-semibold text-[#888] uppercase tracking-wider mb-3">
                          Deductions
                        </h4>
                        <div className="space-y-2">
                          <Row
                            label="Provident Fund (PF)"
                            value={slip.pf}
                          />
                          <Row label="ESI" value={slip.esi} />
                          <Row
                            label="Tax"
                            value={slip.tax}
                          />
                          {slip.otherDeductions > 0 && (
                            <Row
                              label="Other Deductions"
                              value={slip.otherDeductions}
                            />
                          )}
                          <div className="border-t border-[#E8E0D0] pt-2 mt-2">
                            <Row
                              label="Total Deductions"
                              value={slip.pf + slip.esi + slip.tax + slip.otherDeductions}
                              bold
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Net Salary */}
                    <div className="mt-6 pt-4 border-t border-[#E8E0D0] flex items-center justify-between">
                      <span className="font-semibold text-[#1A1A1A] font-serif text-lg">
                        Net Salary
                      </span>
                      <span className="font-bold text-[#1A1A1A] font-serif text-xl">
                        {formatCurrency(slip.netSalary)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: number;
  bold?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={bold ? "font-semibold text-[#1A1A1A]" : "text-[#666]"}>
        {label}
      </span>
      <span className={bold ? "font-semibold text-[#1A1A1A]" : "text-[#1A1A1A]"}>
        {formatCurrency(value)}
      </span>
    </div>
  );
}
