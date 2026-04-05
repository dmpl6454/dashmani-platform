"use client";
import { useState } from "react";
import Link from "next/link";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { Card, CardContent, Badge, Input } from "@dashmani/ui";
import { Search, FolderOpen } from "lucide-react";

const statusColor: Record<string, "default" | "secondary" | "warning" | "danger"> = {
  ACTIVE: "default",
  PAUSED: "warning",
  COMPLETED: "secondary",
  ARCHIVED: "secondary",
};

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useClientProjects({ search });
  const projects = (data as any)?.data || [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Projects</h2>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search projects..." className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : projects.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No projects found.</CardContent></Card>
      ) : (
        <div className="grid gap-4">
          {projects.map((p: any) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="h-5 w-5 text-brand-blue" />
                    <div>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p._count?.tasks || 0} tasks · {p._count?.files || 0} files · {p._count?.approvals || 0} approvals
                      </p>
                    </div>
                  </div>
                  <Badge variant={statusColor[p.status]}>{p.status}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
