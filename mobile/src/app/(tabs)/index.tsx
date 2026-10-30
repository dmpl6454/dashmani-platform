import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import { apiFetch, errorMessage, fmtDay, fmtTime, istDateOf } from "@/lib/api";
import { colors, spacing, toneColors, type } from "@/lib/theme";
import type { TintKey } from "@/lib/theme";
import { tasksCache, useBadges, useDayChange, useTaskList, type Task } from "@/lib/hooks/shared";
import {
  Avatar,
  Button,
  Card,
  IconButton,
  LoadFailed,
  Screen,
  SectionTitle,
  SeeAll,
  useApi,
  useInvalidation,
} from "@/components/ui";
import { DateTile, LargeTitle, ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { SkeletonCard, SkeletonList, SkeletonStatRow } from "@/components/skeleton";

// ---------- API shapes ----------
type Attendance =
  | { isEmployee: false }
  | { totalWorkdays: number; present: number; late: number; halfDay: number; absent: number; rate: number };

type LeaveBucket = { total: number; used: number; balance: number };
type LeaveBalance = Partial<Record<"casual" | "sick" | "earned", LeaveBucket>>;

type Holiday = { id: string; name: string; date: string };

type TodayLink = { url?: string | null; isScheduled?: boolean | null };
type TodayReport = { submittedAt?: string | null; links?: TodayLink[] | null };
/** Wrapped so a loaded "no report today" (API null) is never confused with "not loaded". */
type TodayState = { report: TodayReport | null };

type Section<T> = { status: "ok"; value: T } | { status: "failed"; error: string };

type Rest = {
  attendance: Section<Attendance>;
  leave: Section<LeaveBalance>;
  holidays: Section<Holiday[]>;
  tasks: Section<Task[]>;
};

function settle<T>(r: PromiseSettledResult<T>): Section<T> {
  return r.status === "fulfilled"
    ? { status: "ok", value: r.value }
    : { status: "failed", error: errorMessage(r.reason, "Couldn't load this") };
}

async function loadToday(): Promise<TodayState> {
  const report = await apiFetch<TodayReport | null>("/hr/reports/today");
  return { report: report ?? null };
}

/** Everything on Home except today's report. Never rejects: each section carries its own status. */
async function loadRest(): Promise<Rest> {
  const [attendance, leave, holidays, tasks] = await Promise.allSettled([
    apiFetch<Attendance>("/hr/attendance"),
    apiFetch<LeaveBalance>("/hr/leave-balance"),
    apiFetch<Holiday[]>("/hr/holidays"),
    apiFetch<Task[]>("/hr/tasks"),
  ]);
  if (tasks.status === "fulfilled") tasksCache.setList(Array.isArray(tasks.value) ? tasks.value : []);
  const hol = settle(holidays);
  return {
    attendance: settle(attendance),
    leave: settle(leave),
    holidays: hol.status === "ok" ? { status: "ok", value: Array.isArray(hol.value) ? hol.value : [] } : hol,
    tasks: settle(tasks),
  };
}

// ---------- helpers ----------
function istGreeting(): string {
  const hour = Math.floor((Date.now() / 3600000 + 5.5) % 24);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function untilLabel(day: string, today: string): string {
  const n = Math.round(dayNumber(day) - dayNumber(today));
  if (n <= 0) return "Today";
  if (n === 1) return "Tomorrow";
  return `In ${n} days`;
}

function priorityTint(priority: string | null | undefined): TintKey {
  switch ((priority ?? "").toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "red";
    case "MEDIUM":
      return "orange";
    case "LOW":
      return "blue";
    default:
      return "gray";
  }
}

function accountLabel(t: Task): string {
  if (t.account?.displayName) return t.account.displayName;
  if (t.account?.handle) return `@${t.account.handle}`;
  return "";
}

type DueTask = { task: Task; day: string; overdue: boolean };

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { unread } = useBadges();

  // The IST day is part of both queries' deps: a day rollover is a deps change, so useApi
  // refetches and, if that refetch fails, drops yesterday's data instead of showing it as
  // today's. No explicit reload is needed here.
  const today = useDayChange(() => undefined);

  // The ONLY focus / foreground refetch on Home (one request).
  const todayQ = useApi<TodayState>(loadToday, [today], {
    refetchOnFocus: true,
    refetchOnForeground: true,
    staleMs: 30000,
    keepData: true,
  });
  // Attendance, leave, holidays, tasks: pull-to-refresh, invalidation and day change only.
  const restQ = useApi<Rest>(loadRest, [today], { keepData: true });

  useInvalidation("report", () => {
    void todayQ.reload();
  });
  useInvalidation("leave", () => {
    void restQ.reload();
  });

  const refreshAll = async () => {
    await Promise.all([todayQ.refresh(), restQ.refresh()]);
  };

  const rest = restQ.data;
  const taskList = useTaskList();

  const dueTasks = useMemo<DueTask[] | null>(() => {
    if (!taskList) return null;
    const out: DueTask[] = [];
    for (const task of taskList) {
      const s = (task.status || "").toUpperCase();
      if (s === "DONE" || s === "CANCELLED") continue;
      const day = task.dueDate ? istDateOf(task.dueDate) : null;
      if (!day || day > today) continue;
      out.push({ task, day, overdue: day < today });
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return out.slice(0, 3);
  }, [taskList, today]);

  const upcoming = useMemo<Array<{ holiday: Holiday; day: string }>>(() => {
    if (!rest || rest.holidays.status !== "ok") return [];
    const out: Array<{ holiday: Holiday; day: string }> = [];
    for (const holiday of rest.holidays.value) {
      const day = istDateOf(holiday.date);
      if (day && day >= today) out.push({ holiday, day });
    }
    out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return out.slice(0, 3);
  }, [rest, today]);

  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] ?? "";
  const subtitle = [fmtDay(today, { weekday: true }), firstName].filter(Boolean).join(" · ");

  // ---------- report card ----------
  let reportCard: React.ReactNode;
  if (todayQ.data) {
    const report = todayQ.data.report;
    const links = (report?.links ?? []).filter((l) => !l.isScheduled && !!l.url?.trim());
    const count = links.length;
    if (report && count > 0) {
      const t = toneColors("success");
      const at = report.submittedAt ? fmtTime(report.submittedAt) : "";
      reportCard = (
        <Card
          variant="tinted"
          tone="success"
          onPress={() => router.push("/(tabs)/report")}
          accessibilityLabel={`${count} link${count === 1 ? "" : "s"} submitted today. Opens the daily report.`}
        >
          <View style={styles.reportRow}>
            <Ionicons name="checkmark-circle" size={28} color={t.fg} />
            <View style={styles.flex}>
              <Text maxFontSizeMultiplier={1.6} style={[styles.reportTitle, { color: t.text }]}>
                {`${count} link${count === 1 ? "" : "s"} submitted today${at && at !== "—" ? ` · ${at}` : ""}`}
              </Text>
              <Text maxFontSizeMultiplier={1.6} style={styles.reportSub}>
                Tap to add more links
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.faint} />
          </View>
        </Card>
      );
    } else {
      const t = toneColors("warning");
      reportCard = (
        <Card variant="tinted" tone="warning">
          <View style={styles.reportRow}>
            <Ionicons name="alert-circle" size={28} color={t.fg} />
            <View style={styles.flex}>
              <Text maxFontSizeMultiplier={1.6} style={[styles.reportTitle, { color: t.text }]}>
                No report yet today
              </Text>
              <Text maxFontSizeMultiplier={1.6} style={styles.reportSub}>
                Paste the links you posted today and submit.
              </Text>
            </View>
          </View>
          <Button
            size="md"
            title="Paste today's links"
            icon="clipboard-outline"
            onPress={() => router.push("/(tabs)/report?paste=1")}
            style={styles.reportButton}
          />
        </Card>
      );
    }
  } else if (todayQ.status === "failed" && !todayQ.fetching) {
    reportCard = (
      <Card>
        <View style={styles.reportRow}>
          <Ionicons name="cloud-offline-outline" size={28} color={colors.sub} />
          <View style={styles.flex}>
            <Text maxFontSizeMultiplier={1.6} style={styles.reportTitleNeutral}>
              Couldn't check today's report
            </Text>
            <Text maxFontSizeMultiplier={1.6} style={styles.reportSub}>
              Your submitted links are safe. Check your connection and try again.
            </Text>
          </View>
        </View>
        <Button
          size="sm"
          variant="tinted"
          title="Try again"
          icon="refresh"
          fullWidth={false}
          onPress={() => todayQ.reload()}
          style={styles.reportButton}
        />
      </Card>
    );
  } else {
    reportCard = <SkeletonCard lines={2} />;
  }

  // ---------- today's tasks ----------
  let tasksNode: React.ReactNode;
  if (dueTasks) {
    tasksNode =
      dueTasks.length === 0 ? (
        <ListGroup>
          <ListItem
            icon="checkmark-done-outline"
            tint="green"
            title="Nothing due today"
            subtitle="You're all caught up"
          />
        </ListGroup>
      ) : (
        <ListGroup>
          {dueTasks.map(({ task, day, overdue }) => {
            const acct = accountLabel(task);
            const when = overdue ? `Overdue · ${fmtDay(day, { weekday: false })}` : "Due today";
            return (
              <ListItem
                key={task.id}
                icon={overdue ? "alert-circle-outline" : "time-outline"}
                tint={priorityTint(task.priority)}
                title={task.title}
                subtitle={acct ? `${when} · ${acct}` : when}
                onPress={() => router.push(`/task/${task.id}`)}
              />
            );
          })}
        </ListGroup>
      );
  } else if (rest && rest.tasks.status === "failed") {
    tasksNode = (
      <Card>
        <LoadFailed error={rest.tasks.error} compact onRetry={() => restQ.reload()} />
      </Card>
    );
  } else {
    tasksNode = <SkeletonList rows={2} tile />;
  }

  // ---------- this month ----------
  let monthNode: React.ReactNode;
  if (!rest) {
    monthNode = <SkeletonStatRow count={2} />;
  } else {
    const att = rest.attendance;
    const leave = rest.leave;
    const tiles: React.ReactNode[] = [];

    if (att.status === "ok") {
      const a = att.value;
      if ("totalWorkdays" in a) {
        tiles.push(
          <StatTile
            key="att"
            label="Present days"
            value={`${a.present}/${a.totalWorkdays}`}
            icon="calendar-outline"
            tone="success"
            progress={a.totalWorkdays > 0 ? a.present / a.totalWorkdays : undefined}
            hint={`${a.rate}% · ${a.late} late`}
            onPress={() => router.push("/attendance")}
          />,
        );
      }
    } else {
      tiles.push(
        <StatTile
          key="att"
          label="Attendance"
          value="—"
          icon="cloud-offline-outline"
          tone="danger"
          hint="Couldn't load · tap to retry"
          onPress={() => restQ.reload()}
        />,
      );
    }

    if (leave.status === "ok") {
      const b = leave.value;
      const casual = b.casual?.balance ?? 0;
      const sick = b.sick?.balance ?? 0;
      const earned = b.earned?.balance ?? 0;
      tiles.push(
        <StatTile
          key="leave"
          label="Leave days left"
          value={casual + sick + earned}
          icon="airplane-outline"
          tone="info"
          hint={`Casual ${casual} · Sick ${sick} · Earned ${earned}`}
          onPress={() => router.push("/(tabs)/leave")}
        />,
      );
    } else {
      tiles.push(
        <StatTile
          key="leave"
          label="Leave balance"
          value="—"
          icon="cloud-offline-outline"
          tone="danger"
          hint="Couldn't load · tap to retry"
          onPress={() => restQ.reload()}
        />,
      );
    }

    monthNode = <StatGrid columns={2}>{tiles}</StatGrid>;
  }

  // ---------- holidays ----------
  let holidaysNode: React.ReactNode;
  if (!rest) {
    holidaysNode = <SkeletonList rows={2} tile />;
  } else if (rest.holidays.status === "failed") {
    holidaysNode = (
      <ListGroup>
        <ListItem
          icon="cloud-offline-outline"
          tint="red"
          title="Couldn't load holidays"
          subtitle="Tap to retry"
          chevron={false}
          trailing={<Ionicons name="refresh" size={18} color={colors.purple} />}
          onPress={() => restQ.reload()}
        />
      </ListGroup>
    );
  } else if (upcoming.length === 0) {
    holidaysNode = (
      <ListGroup>
        <ListItem icon="sunny-outline" tint="orange" title="No upcoming holidays this year" />
      </ListGroup>
    );
  } else {
    holidaysNode = (
      <ListGroup>
        {upcoming.map(({ holiday, day }) => (
          <ListItem
            key={holiday.id}
            leading={<DateTile date={day} />}
            title={holiday.name}
            subtitle={`${fmtDay(day, { weekday: true })} · ${untilLabel(day, today)}`}
          />
        ))}
      </ListGroup>
    );
  }

  return (
    <Screen header="none" onRefresh={refreshAll} refreshing={todayQ.refreshing || restQ.refreshing}>
      <LargeTitle
        title={istGreeting()}
        subtitle={subtitle}
        right={
          <View style={styles.titleRight}>
            <IconButton
              icon="notifications-outline"
              label={unread ? `Notifications, ${unread} unread` : "Notifications"}
              badge={unread}
              onPress={() => router.push("/notifications")}
            />
            <Pressable
              onPress={() => router.push("/profile")}
              accessibilityRole="button"
              accessibilityLabel="My profile"
              hitSlop={4}
              style={({ pressed }) => (pressed ? styles.pressed : null)}
            >
              <Avatar name={user?.name ?? ""} uri={user?.profileImageUrl} size={36} ring />
            </Pressable>
          </View>
        }
      />

      {reportCard}

      <SectionTitle right={<SeeAll onPress={() => router.push("/(tabs)/tasks")} />}>Today</SectionTitle>
      {tasksNode}

      <SectionTitle right={<SeeAll onPress={() => router.push("/attendance")} label="Details" />}>
        This month
      </SectionTitle>
      {monthNode}

      <SectionTitle right={<SeeAll onPress={() => router.push("/holidays")} />}>Upcoming holidays</SectionTitle>
      {holidaysNode}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  titleRight: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  pressed: { opacity: 0.6 },
  reportRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  reportTitle: { ...type.headline },
  reportTitleNeutral: { ...type.headline, color: colors.ink },
  reportSub: { ...type.footnote, color: colors.sub, marginTop: 2 },
  reportButton: { marginTop: spacing.md },
});
