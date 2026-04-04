"use client";
import { useEffect, useState } from "react";
import { EmployeeForm } from "@/components/employee-form";
import { apiFetch } from "@/lib/api";

export default function NewEmployeePage() {
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    apiFetch("/roles").then((res: any) => setRoles(res.data));
  }, []);

  return (
    <div className="max-w-2xl">
      <EmployeeForm roles={roles} />
    </div>
  );
}
