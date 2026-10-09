"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { EmployeeForm } from "@/components/employee-form";
import { apiFetch } from "@/lib/api";

export default function NewEmployeePage() {
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    apiFetch("/roles").then((res: any) => setRoles(res.data));
  }, []);

  return (
    <div className="max-w-2xl pb-8">
      <div className="pt-[22px] pb-4">
        <Link href="/employees" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ds-t2 hover:text-ds-gold transition-colors">
          <ChevronLeft className="h-3.5 w-3.5" /> Employees
        </Link>
      </div>
      <EmployeeForm roles={roles} />
    </div>
  );
}
