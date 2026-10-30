import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtDay } from "@/lib/api";
import { colors, formatStatus, spacing, statusColor, type } from "@/lib/theme";
import { Avatar, Card, Chips, Empty, Screen, SectionTitle, useApi } from "@/components/ui";
import type { IoniconName } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";

const TABS = ["TASKS", "ATTENDANCE", "CONTENT", "PROJECTS"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { TASKS: "Tasks", ATTENDANCE: "Attendance", CONTENT: "Content", PROJECTS: "Projects" };

// Shapes returned by apps/api/src/services/analytics.service.ts.
type TaskAnalytics = {
  totalTasks: number;
  byStatus?: Array<{ status: string; count: number }>;
  byPriority?: Array<{ priority: string; count: number }>;
  completionRate: number;
  topAssignees?: Array<{ assigneeId: string; assigneeName: string; total: number; done: number }>;
  completedThisMonth: number;
  overdueCount: number;
};

type AttendanceAnalytics = {
  totalEmployees: number;
  presentToday: number;
  absentToday: number;
  lateToday: number;
  onLeaveToday: number;
  attendanceRate: number;
  dailyBreakdown?: Array<{ date: string; present: number; absent: number; late: number; leave: number }>;
};

type ContentAnalytics = {
  totalPosts: number;
  byStatus?: Array<{ status: string; count: number }>;
  byPlatform?: Array<{ platformName: string; count: number }>;
  publishedThisMonth: number;
  scheduledUpcoming: number;
};

type ProjectAnalytics = {
  totalProjects: number;
  activeProjects: number;
  projects?: Array<{
    projectId: string;
    projectName: string;
    clientName: string;
    status: string;
    totalTasks: number;
    completedTasks: number;
    pendingApprovals: number;
    taskCompletionPercent: number;
  }>;
};

/** Each answer carries the tab it was fetched for, so data kept across a tab switch never renders under the wrong layout. */
type Analytics =
  | { kind: "TASKS"; data: TaskAnalytics }
  | { kind: "ATTENDANCE"; data: AttendanceAnalytics }
  | { kind: "CONTENT"; data: ContentAnalytics }
  | { kind: "PROJECTS"; data: ProjectAnalytics };

async function loadAnalytics(tab: Tab): Promise<Analytics> {
  switch (tab) {
    case "TASKS":
      return { kind: "TASKS", data: await apiFetch<TaskAnalytics>("/analytics/tasks") };
    case "ATTENDANCE":
      return { kind: "ATTENDANCE", data: await apiFetch<AttendanceAnalytics>("/analytics/attendance") };
    case "CONTENT":
      return { kind: "CONTENT", data: await apiFetch<ContentAnalytics>("/analytics/content") };
    case "PROJECTS":
      return { kind: "PROJECTS", data: await apiFetch<ProjectAnalytics>("/analytics/projects") };
  }
}

const n = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function priorityColor(p: string): string {
  switch (p.toUpperCase()) {
    case "URGENT":
    case "CRITICAL":
      return colors.red;
    case "HIGH":
      return colors.warning;
    case "MEDIUM":
      return colors.blue;
    case "LOW":
      return colors.tint.gray;
    default:
      return colors.purple;
  }
}

type Bar = { key: string; label: string; value: number; color: string };

const byValue = (a: Bar, b: Bar): number => b.value - a.value;

export default function AdminAnalytics() {
  const [tab, setTab] = useState<Tab>("TASKS");
  const state = useApi<Analytics>(() => loadAnalytics(tab), [tab], { keepData: true });
  const stale = state.data !== null && state.data.kind !== tab;
  const switching = state.fetching && !state.refreshing && stale;

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <View style={styles.tabPicker}>
        <Chips options={TABS} value={tab} onChange={setTab} labels={TAB_LABELS} accessibilityLabel="Analytics area" />
      </View>
      <AsyncBlock
        state={state}
        skeleton={
          <View>
            <SkeletonStatRow count={2} />
            <SkeletonStatRow count={2} />
            <SkeletonList rows={4} />
          </View>
        }
      >
        {(a) => (
          <View style={switching ? styles.dimmed : null} accessibilityState={{ busy: switching }}>
            {a.kind === "TASKS" ? (
              <TasksView d={a.data} />
            ) : a.kind === "ATTENDANCE" ? (
              <AttendanceView d={a.data} />
            ) : a.kind === "CONTENT" ? (
              <ContentView d={a.data} />
            ) : (
              <ProjectsView d={a.data} />
            )}
          </View>
        )}
      </AsyncBlock>
    </Screen>
  );
}

function TasksView({ d }: { d: TaskAnalytics }) {
  const total = n(d.totalTasks);
  const rate = n(d.completionRate);
  const statusBars: Bar[] = (d.byStatus ?? [])
    .map((r) => ({ key: r.status, label: formatStatus(r.status), value: n(r.count), color: statusColor(r.status).dot }))
    .sort(byValue);
  const priorityBars: Bar[] = (d.byPriority ?? [])
    .map((r) => ({ key: r.priority, label: formatStatus(r.priority), value: n(r.count), color: priorityColor(r.priority) }))
    .sort(byValue);
  const assignees = d.topAssignees ?? [];

  return (
    <>
      <StatGrid>
        <StatTile label="Total tasks" icon="list-outline" value={total} />
        <StatTile label="Done this month" icon="checkmark-done-outline" tone="success" value={n(d.completedThisMonth)} />
        <StatTile
          label="Overdue"
          icon="alert-circle-outline"
          tone="danger"
          value={n(d.overdueCount)}
          valueColor={n(d.overdueCount) > 0 ? colors.redText : undefined}
        />
        <StatTile label="Completion rate" icon="pie-chart-outline" value={`${rate}%`} progress={rate / 100} />
      </StatGrid>

      <SectionTitle>By status</SectionTitle>
      <BarCard bars={statusBars} max={total} emptyIcon="checkbox-outline" emptyText="No tasks yet" />

      <SectionTitle>By priority</SectionTitle>
      <BarCard bars={priorityBars} max={total} emptyIcon="flag-outline" emptyText="No tasks yet" />

      <SectionTitle>Top assignees</SectionTitle>
      {assignees.length === 0 ? (
        <Card>
          <Empty compact icon="people-outline" text="No tasks are assigned yet" />
        </Card>
      ) : (
        <ListGroup>
          {assignees.map((a, i) => (
            <ListItem
              key={a.assigneeId ?? String(i)}
              title={a.assigneeName || "Unknown"}
              subtitle={`${n(a.total)} assigned`}
              detail={`${n(a.done)} done`}
              leading={<Avatar name={a.assigneeName || "?"} size={32} />}
            />
          ))}
        </ListGroup>
      )}
    </>
  );
}

function AttendanceView({ d }: { d: AttendanceAnalytics }) {
  const totalEmployees = n(d.totalEmployees);
  const rate = n(d.attendanceRate);
  const days = [...(d.dailyBreakdown ?? [])].reverse();

  return (
    <>
      <StatGrid>
        <StatTile label="Present today" icon="checkmark-circle-outline" tone="success" value={n(d.presentToday)} hint={`of ${totalEmployees} employees`} />
        <StatTile label="Attendance rate" icon="pie-chart-outline" value={`${rate}%`} progress={rate / 100} />
        <StatTile label="Late" icon="time-outline" tone="warning" value={n(d.lateToday)} />
        <StatTile label="Absent" icon="close-circle-outline" tone="danger" value={n(d.absentToday)} />
        <StatTile label="On leave" icon="airplane-outline" tone="info" value={n(d.onLeaveToday)} />
        <StatTile label="Employees" icon="people-outline" tone="neutral" value={totalEmployees} />
      </StatGrid>

      <SectionTitle>Last 7 days</SectionTitle>
      {days.length === 0 ? (
        <Card>
          <Empty compact icon="calendar-outline" text="No attendance marked in the last 7 days" />
        </Card>
      ) : (
        <ListGroup footer="Present includes late and half-day.">
          {days.map((day) => (
            <ListItem
              key={day.date}
              title={fmtDay(day.date)}
              subtitle={`${n(day.late)} late · ${n(day.absent)} absent · ${n(day.leave)} on leave`}
              detail={`${n(day.present)} present`}
            />
          ))}
        </ListGroup>
      )}
    </>
  );
}

function ContentView({ d }: { d: ContentAnalytics }) {
  const total = n(d.totalPosts);
  const statusBars: Bar[] = (d.byStatus ?? [])
    .map((r) => ({ key: r.status, label: formatStatus(r.status), value: n(r.count), color: statusColor(r.status).dot }))
    .sort(byValue);
  const platformBars: Bar[] = (d.byPlatform ?? [])
    .map((r) => ({ key: r.platformName, label: r.platformName || "Unknown", value: n(r.count), color: colors.blue }))
    .sort(byValue);

  return (
    <>
      <StatGrid columns={3}>
        <StatTile compact label="Total posts" value={total} />
        <StatTile compact label="Published (mo)" tone="success" value={n(d.publishedThisMonth)} />
        <StatTile compact label="Scheduled" tone="warning" value={n(d.scheduledUpcoming)} />
      </StatGrid>

      <SectionTitle>By status</SectionTitle>
      <BarCard bars={statusBars} max={total} emptyIcon="document-text-outline" emptyText="No content yet" />

      <SectionTitle>By platform</SectionTitle>
      <BarCard bars={platformBars} max={total} emptyIcon="globe-outline" emptyText="No content yet" />
    </>
  );
}

function ProjectsView({ d }: { d: ProjectAnalytics }) {
  const projects = d.projects ?? [];
  return (
    <>
      <StatGrid>
        <StatTile label="Projects" icon="folder-outline" value={n(d.totalProjects)} />
        <StatTile label="Active" icon="play-circle-outline" tone="success" value={n(d.activeProjects)} />
      </StatGrid>

      <SectionTitle>Task completion</SectionTitle>
      {projects.length === 0 ? (
        <Card>
          <Empty compact icon="folder-outline" text="No projects yet" />
        </Card>
      ) : (
        <ListGroup>
          {projects.map((p) => {
            const pending = n(p.pendingApprovals);
            return (
              <ListItem
                key={p.projectId}
                title={p.projectName}
                subtitle={`${p.clientName} · ${n(p.completedTasks)}/${n(p.totalTasks)} tasks${
                  pending > 0 ? ` · ${pending} awaiting approval` : ""
                }`}
                detail={`${n(p.taskCompletionPercent)}%`}
              />
            );
          })}
        </ListGroup>
      )}
    </>
  );
}

function BarCard({ bars, max, emptyIcon, emptyText }: { bars: Bar[]; max: number; emptyIcon: IoniconName; emptyText: string }) {
  if (bars.length === 0) {
    return (
      <Card>
        <Empty compact icon={emptyIcon} text={emptyText} />
      </Card>
    );
  }
  const top = Math.max(max, ...bars.map((b) => b.value), 1);
  return (
    <Card>
      {bars.map((b) => (
        <BarRow key={b.key} label={b.label} value={b.value} max={top} color={b.color} />
      ))}
    </Card>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = value > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return (
    <View style={styles.barRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.barLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={styles.barValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabPicker: { marginBottom: spacing.md },
  dimmed: { opacity: 0.55 },
  barRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 7 },
  barLabel: { ...type.footnote, width: 96, color: colors.ink, fontWeight: "600" },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.cardHigh, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  barValue: { ...type.footnote, ...type.numeric, width: 40, fontWeight: "700", color: colors.sub, textAlign: "right" },
});
