"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useEmployee } from "@/lib/hooks/use-employees";
import { EmployeeForm } from "@/components/employee-form";
import { apiFetch } from "@/lib/api";

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const { data, isLoading } = useEmployee(id as string);
  const [roles, setRoles] = useState([]);

  useEffect(() => {
    apiFetch("/roles").then((res: any) => setRoles(res.data));
  }, []);

  if (isLoading) return <div>Loading...</div>;

  const employee = (data as any)?.data;
  if (!employee) return <div>Employee not found</div>;

  return (
    <div className="max-w-2xl">
      <EmployeeForm employee={employee} roles={roles} />
    </div>
  );
}
