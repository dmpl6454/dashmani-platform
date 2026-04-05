"use client";
import { useState } from "react";
import Link from "next/link";
import { useClients } from "@/lib/hooks/use-clients";
import { Button, Input, Badge, Card, CardContent } from "@dashmani/ui";
import { Plus, Search, Building2 } from "lucide-react";

export default function ClientsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useClients({ search });
  const clients = (data as any)?.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Clients</h2>
        <Link href="/clients/new"><Button><Plus className="h-4 w-4 mr-2" /> New Client</Button></Link>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Search clients..." className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <div className="grid gap-3">
          {clients.map((c: any) => (
            <Link key={c.id} href={`/clients/${c.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Building2 className="h-5 w-5 text-brand-blue" />
                    <div>
                      <p className="font-medium">{c.companyName}</p>
                      <p className="text-xs text-muted-foreground">{c.contactName} · {c.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{c._count?.projects || 0} projects</span>
                    <Badge variant={c.status === "ACTIVE" ? "default" : "secondary"}>{c.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
