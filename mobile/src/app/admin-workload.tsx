import React from "react";
import { apiFetch } from "@/lib/api";
import { Avatar, Screen, useApi } from "@/components/ui";
import { ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncList } from "@/components/async";

const PRIORITIES = ["critical", "high", "medium", "low"] as const;
type Priority = (typeof PRIORITIES)[number];

// GET /workload → accountService.getWorkloadMatrix(): one row per active employee.
type WorkloadRow = {
  id?: string;
  employeeId?: string;
  name?: string | null;
  employeeName?: string | null;
  team?: { name?: string | null } | null;
  accountCount?: number;
  accounts?: unknown;
  openTaskCount?: number;
  taskCount?: number;
  openTasks?: number;
  tasksByPriority?: Partial<Record<Priority, number>> | null;
};

type WorkloadPayload = WorkloadRow[] | { items?: WorkloadRow[] | null; employees?: WorkloadRow[] | null };

function accountsOf(r: WorkloadRow): number {
  if (typeof r.accountCount === "number") return r.accountCount;
  return Array.isArray(r.accounts) ? r.accounts.length : 0;
}

function openTasksOf(r: WorkloadRow): number {
  return r.openTaskCount ?? r.taskCount ?? r.openTasks ?? 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function AdminWorkload() {
  const list = useApi<WorkloadRow[]>(async () => {
    const d = await apiFetch<WorkloadPayload>("/workload");
    if (Array.isArray(d)) return d;
    return d?.items ?? d?.employees ?? [];
  });

  const rows = list.data ?? [];
  const totalAccounts = rows.reduce((s, r) => s + accountsOf(r), 0);
  const totalTasks = rows.reduce((s, r) => s + openTasksOf(r), 0);

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        grouped
        skeleton="stats"
        header={
          rows.length > 0 ? (
            <StatGrid columns={3}>
              <StatTile compact label="People" value={rows.length} icon="people-outline" tone="info" />
              <StatTile compact label="Accounts" value={totalAccounts} icon="at-outline" tone="brand" />
              <StatTile compact label="Open tasks" value={totalTasks} icon="checkbox-outline" tone="warning" />
            </StatGrid>
          ) : null
        }
        keyExtractor={(r, i) => r.employeeId ?? r.id ?? String(i)}
        renderItem={(r) => {
          const name = r.employeeName ?? r.name ?? "Employee";
          const byPr = r.tasksByPriority ?? {};
          const urgent = (byPr.critical ?? 0) + (byPr.high ?? 0);
          const priorityLine = PRIORITIES.filter((k) => (byPr[k] ?? 0) > 0)
            .map((k) => `${byPr[k] ?? 0} ${k}`)
            .join(" · ");
          const line1 = [r.team?.name, plural(accountsOf(r), "account", "accounts"), plural(openTasksOf(r), "open task", "open tasks")]
            .filter((p): p is string => typeof p === "string" && p !== "")
            .join(" · ");
          return (
            <ListItem
              leading={<Avatar name={name} size={32} />}
              title={name}
              subtitle={priorityLine ? `${line1}\n${priorityLine}` : line1}
              badge={urgent > 0 ? urgent : undefined}
              accessibilityLabel={`${name}. ${line1}${priorityLine ? `. ${priorityLine}` : ""}`}
            />
          );
        }}
        empty={{ icon: "pulse-outline", title: "No workload data", text: "Active employees with accounts or open tasks appear here." }}
      />
    </Screen>
  );
}
