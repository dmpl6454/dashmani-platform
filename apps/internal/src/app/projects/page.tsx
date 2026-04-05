"use client";
import { useState } from "react";
import Link from "next/link";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button, Input, Badge, Card, CardContent } from "@dashmani/ui";
import { Plus, Search, FolderOpen } from "lucide-react";

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useProjects({ search });
  const projects = (data as any)?.data || [];

  const statusColor: Record<string, "default" | "secondary" | "warning"> = {
    ACTIVE: "default", PAUSED: "warning", COMPLETED: "secondary", ARCHIVED: "secondary",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Projects</h2>
        <Link href="/projects/new"><Button><Plus className="h-4 w-4 mr-2" /> New Project</Button></Link>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search projects..." className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {isLoading ? <p className="text-muted-foreground">Loading...</p> : (
        <div className="grid gap-3">
          {projects.map((p: any) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FolderOpen className="h-5 w-5 text-brand-blue" />
                    <div>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.client?.companyName} · {p._count?.tasks || 0} tasks</p>
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
