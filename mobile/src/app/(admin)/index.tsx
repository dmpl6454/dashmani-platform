import React, { useCallback } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/lib/auth";
import {
  apiFetch,
  addDaysISO,
  daysAgoIST,
  errorMessage,
  fmtCompact,
  fmtDay,
  fmtTime,
  fmtUsdCents,
  isApiError,
  todayIST,
} from "@/lib/api";
import { colors, radius, spacing, toneColors, type, type Tone } from "@/lib/theme";
import {
  Avatar,
  Button,
  Card,
  Empty,
  ErrorBanner,
  IconButton,
  LoadFailed,
  Screen,
  SectionTitle,
  SeeAll,
  TrendBars,
  useApi,
  useInvalidation,
} from "@/components/ui";
import { LargeTitle, ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";
import { useDayChange, usePendingCounts, type PendingCounts } from "@/lib/hooks/shared";

// ---------- response parsing (API answers are read defensively, never as `any`) ----------
type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A count that may arrive as a number or wrapped as `{ count }` / `{ _count }`. */
function countOf(v: unknown): number {
  if (typeof v === "number") return v;
  const r = rec(v);
  return r ? countOf(r.count ?? r._count ?? 0) : 0;
}

function countWhere(v: unknown, statuses: readonly string[]): number {
  return list(v).filter((x) => statuses.includes(str(rec(x)?.status) ?? "")).length;
}

type ErrorInfo = { message: string; code: string | null; status: number | null };

/** One dashboard source: loaded, failed, or not requested for this role. */
type Src<T> = { state: "ok"; value: T } | { state: "failed"; error: ErrorInfo } | { state: "skipped" };

const SKIP: unique symbol = Symbol("skip");

function call(on: boolean, path: string): Promise<unknown> {
  return on ? apiFetch<unknown>(path) : Promise.resolve(SKIP);
}

function settle<T>(r: PromiseSettledResult<unknown>, parse: (v: unknown) => T): Src<T> {
  if (r.status === "rejected") {
    const e: unknown = r.reason;
    return {
      state: "failed",
      error: {
        message: errorMessage(e, "Couldn't load the dashboard."),
        code: isApiError(e) ? (e.code ?? null) : null,
        status: isApiError(e) ? (e.status ?? null) : null,
      },
    };
  }
  if (r.value === SKIP) return { state: "skipped" };
  return { state: "ok", value: parse(r.value) };
}

function valueOf<T>(s: Src<T> | undefined): T | null {
  return s && s.state === "ok" ? s.value : null;
}

type TrendPoint = { date: string; count: number };

type Overview = {
  totalEmployees: number | null;
  presentToday: number | null;
  submittedTodayCount: number | null;
  submissionRateToday: number | null;
  linksToday: number | null;
  linksThisWeek: number | null;
  linksThisMonth: number | null;
  activeTeams: number | null;
  activeProjects: number | null;
  contentPublishedThisMonth: number | null;
  linksTrend: TrendPoint[];
};

function parseOverview(v: unknown): Overview {
  const o: Json = rec(v) ?? {};
  return {
    totalEmployees: num(o.totalEmployees),
    presentToday: num(o.presentToday),
    submittedTodayCount: num(o.submittedTodayCount),
    submissionRateToday: num(o.submissionRateToday),
    linksToday: num(o.linksToday),
    linksThisWeek: num(o.linksThisWeek),
    linksThisMonth: num(o.linksThisMonth),
    activeTeams: num(o.activeTeams),
    activeProjects: num(o.activeProjects),
    contentPublishedThisMonth: num(o.contentPublishedThisMonth),
    linksTrend: list(o.linksTrend).flatMap((t): TrendPoint[] => {
      const r = rec(t);
      const date = str(r?.date);
      return r && date ? [{ date, count: num(r.count) ?? 0 }] : [];
    }),
  };
}

type Poa = { written: number; expected: number };

function parsePoa(v: unknown): Poa {
  const o: Json = rec(v) ?? {};
  const written = num(o.submittedCount) ?? 0;
  return { written, expected: num(o.totalEmployees) ?? written + list(o.nonSubmitters).length };
}

type LinksToday = { notYet: number };

function parseLinksToday(v: unknown): LinksToday {
  return { notYet: list(rec(v)?.nonSubmitters).length };
}

type Performer = { id: string; name: string; reports: number; links: number };

function parseTop(v: unknown): Performer[] {
  return list(rec(v)?.employees)
    .flatMap((e): Performer[] => {
      const r = rec(e);
      const id = str(r?.employeeId) ?? str(r?.id);
      if (!r || !id) return [];
      return [
        {
          id,
          name: str(r.employeeName) ?? str(r.name) ?? "Employee",
          reports: num(r.reportCount) ?? 0,
          links: num(r.totalLinks) ?? 0,
        },
      ];
    })
    .sort((a, b) => b.links - a.links)
    .slice(0, 3);
}

type TaskStats = { open: number; overdue: number; rate: number | null };

function parseTasks(v: unknown): TaskStats | null {
  const t = rec(v);
  if (!t) return null;
  const total = num(t.totalTasks) ?? 0;
  const done = countOf(list(t.byStatus).find((x) => rec(x)?.status === "DONE"));
  return { open: Math.max(0, total - done), overdue: num(t.overdueCount) ?? 0, rate: num(t.completionRate) };
}

type Growth = {
  views: number | null;
  engagements: number | null;
  followers: number | null;
  earningsCents: number | null;
  channelCount: number | null;
};

/** null = loaded, but there is no Meta data for the window. */
function parseGrowth(v: unknown): Growth | null {
  const g = rec(v);
  const totals = rec(g?.totals);
  if (!g || !totals) return null;
  const channelCount = num(g.channelCount);
  if (channelCount === 0) return null;
  return {
    views: num(totals.views),
    engagements: num(totals.engagements),
    followers: num(totals.followers),
    earningsCents: num(totals.earningsCents),
    channelCount,
  };
}

type Watch = { live: boolean; windowActive: boolean; nextStart: string | null; pausedUntil: string | null; silent: number };

function parseWatch(v: unknown): Watch {
  const w: Json = rec(v) ?? {};
  const counts: Json = rec(w.counts) ?? {};
  const win: Json = rec(w.window) ?? {};
  const monitor: Json = rec(w.monitor) ?? {};
  return {
    live: w.status === "ok",
    windowActive: win.active !== false,
    nextStart: str(win.nextStart),
    pausedUntil: str(monitor.pausedUntil),
    silent: (num(counts.quiet_today) ?? 0) + (num(counts.no_post_today) ?? 0),
  };
}

const parseOpenApps = (v: unknown) => countWhere(v, ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW"]);
const parseOpenComplaints = (v: unknown) => countWhere(v, ["OPEN"]);
const parseOpenBugs = (v: unknown) => countWhere(v, ["OPEN", "IN_PROGRESS"]);
const parseCampaignsToDo = (v: unknown) => countWhere(v, ["paid_pending_review", "approved", "publishing"]);

type Phase1 = {
  overview: Src<Overview>;
  poa: Src<Poa>;
  linksToday: Src<LinksToday>;
  top: Src<Performer[]>;
  tasks: Src<TaskStats | null>;
};

type Phase2 = {
  growth: Src<Growth | null>;
  apps: Src<number>;
  complaints: Src<number>;
  bugs: Src<number>;
  campaigns: Src<number>;
  watch: Src<Watch>;
};

// ---------- display helpers ----------
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function orDash(v: number | null | undefined): string | number {
  return v == null ? "—" : v;
}

/** "…" while the second phase is still loading, "—" when the source failed. */
function countRow(s: Src<number> | undefined): { detail?: string; badge?: number } {
  if (!s) return { detail: "…" };
  if (s.state !== "ok") return { detail: "—" };
  return s.value > 0 ? { badge: s.value } : { detail: "None open" };
}

function countTile(s: Src<number> | undefined): string | number {
  if (!s) return "…";
  return s.state === "ok" ? s.value : "—";
}

function watchCopy(s: Src<Watch> | undefined): { text: string; quiet: boolean } {
  if (!s) return { text: "Checking…", quiet: false };
  if (s.state !== "ok") return { text: "Couldn't load", quiet: false };
  const w = s.value;
  if (!w.live) return { text: "Not connected", quiet: false };
  if (w.pausedUntil && Date.parse(w.pausedUntil) > Date.now()) {
    return { text: `Paused · resumes ${fmtTime(w.pausedUntil)}`, quiet: false };
  }
  if (!w.windowActive) {
    return { text: w.nextStart ? `Paused · resumes ${fmtTime(w.nextStart)}` : "Paused", quiet: false };
  }
  if (w.silent > 0) return { text: `${w.silent} ${plural(w.silent, "channel", "channels")} quiet`, quiet: true };
  return { text: "All on schedule", quiet: false };
}

function campaignCopy(s: Src<number> | undefined): string {
  if (!s) return "Checking…";
  if (s.state !== "ok") return "Couldn't load";
  return s.value > 0 ? `${s.value} to review or post` : "Nothing to do";
}

/** Greeting by the IST hour, independent of the device time zone. */
function greetingIST(): string {
  const hour = new Date(Date.now() + 330 * 60000).getUTCHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

// ---------- pending approvals callout ----------
type PendingQueue = keyof Omit<PendingCounts, "total" | "status">;

const QUEUES: ReadonlyArray<{ key: PendingQueue; tab: string; one: string; many: string }> = [
  { key: "leaves", tab: "LEAVES", one: "leave", many: "leaves" },
  { key: "expenses", tab: "EXPENSES", one: "expense", many: "expenses" },
  { key: "extraHours", tab: "EXTRA_HOURS", one: "extra hrs", many: "extra hrs" },
  { key: "newEmployees", tab: "NEW_EMPLOYEES", one: "joiner", many: "joiners" },
  { key: "documents", tab: "DOCUMENTS", one: "document", many: "documents" },
];

const CHIP_SLOP = { top: 4, bottom: 4, left: 2, right: 2 };

function PendingCallout({
  counts,
  onOpen,
  onRetry,
}: {
  counts: PendingCounts;
  onOpen: (tab?: string) => void;
  onRetry: () => void;
}) {
  const warn = toneColors("warning");
  const anyFailed = QUEUES.some((q) => counts[q.key] === null);

  if (counts.status === "ok" && counts.total === 0 && !anyFailed) {
    return (
      <ListGroup>
        <ListItem
          icon="checkmark-done-outline"
          tint="green"
          title="Approvals"
          detail="Nothing pending"
          onPress={() => onOpen()}
        />
      </ListGroup>
    );
  }

  const headline =
    counts.status === "loading"
      ? "Pending approvals"
      : counts.status === "failed"
        ? "Couldn't load approvals"
        : `${counts.total} pending ${plural(counts.total, "approval", "approvals")}`;
  const chips =
    counts.status === "ok"
      ? QUEUES.filter((q) => {
          const n = counts[q.key];
          return n === null || n > 0;
        })
      : [];

  return (
    <Card variant="tinted" tone="warning">
      <Pressable
        onPress={() => onOpen()}
        accessibilityRole="button"
        accessibilityLabel={`${headline}. Open approvals`}
        style={({ pressed }) => [styles.calloutHead, pressed ? styles.pressed : null]}
      >
        <Ionicons name="alert-circle" size={24} color={warn.fg} />
        <Text maxFontSizeMultiplier={1.6} style={styles.calloutTitle}>
          {headline}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.sub} />
      </Pressable>
      {counts.status === "loading" ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.calloutSub}>
          Counting the queues…
        </Text>
      ) : null}
      {chips.length > 0 ? (
        <View style={styles.chips}>
          {chips.map((q) => {
            const n = counts[q.key];
            const label = n === null ? `? ${q.many}` : `${n} ${plural(n, q.one, q.many)}`;
            return (
              <Pressable
                key={q.key}
                onPress={() => onOpen(q.tab)}
                hitSlop={CHIP_SLOP}
                accessibilityRole="button"
                accessibilityLabel={n === null ? `${q.many}: couldn't load. Open` : `${label}. Open`}
                style={({ pressed }) => [styles.chip, { borderColor: warn.fg }, pressed ? styles.pressed : null]}
              >
                <Text maxFontSizeMultiplier={1.3} style={[styles.chipText, { color: warn.text }]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {counts.status === "failed" || (counts.status === "ok" && anyFailed) ? (
        <Button
          title="Try again"
          variant="tinted"
          tone="warning"
          size="sm"
          fullWidth={false}
          onPress={onRetry}
          style={styles.calloutRetry}
        />
      ) : null}
    </Card>
  );
}

// ---------- screen ----------
const DASH_OPTIONS = { refetchOnFocus: false, refetchOnForeground: true, staleMs: 300000, keepData: true };

const HR_PEOPLE: ReadonlyArray<{
  title: string;
  icon: React.ComponentProps<typeof ListItem>["icon"];
  tint: React.ComponentProps<typeof ListItem>["tint"];
  path: string;
}> = [
  { title: "Employees", icon: "people-outline", tint: "blue", path: "/admin-employees" },
  { title: "Attendance", icon: "time-outline", tint: "orange", path: "/admin-attendance" },
  { title: "Teams", icon: "git-branch-outline", tint: "brand", path: "/admin-teams" },
  { title: "Salary Slips", icon: "cash-outline", tint: "green", path: "/admin-salary-slips" },
  { title: "Holidays", icon: "sunny-outline", tint: "orange", path: "/admin-holidays" },
  { title: "Announcements", icon: "megaphone-outline", tint: "orange", path: "/admin-announcements" },
  { title: "Jobs", icon: "briefcase-outline", tint: "gray", path: "/admin-jobs" },
  { title: "Internships", icon: "school-outline", tint: "blue", path: "/admin-internships" },
  { title: "Complaints", icon: "alert-circle-outline", tint: "orange", path: "/admin-complaints" },
  { title: "Bug reports", icon: "bug-outline", tint: "red", path: "/admin-bug-reports" },
];

export default function AdminDashboard() {
  const router = useRouter();
  const { user, caps } = useAuth();
  // HR-only staff skip the admin-only analytics endpoints (they answer 403 for them).
  const full = caps.isAdmin || !caps.isHr;
  const counts = usePendingCounts();
  const reloadCounts = counts.reload;

  // Phase 1: what the first paint needs.
  const p1 = useApi<Phase1>(
    async () => {
      const today = todayIST();
      const week = `startDate=${daysAgoIST(6)}&endDate=${today}`;
      const [overview, poa, linksToday, summary, tasks] = await Promise.allSettled([
        call(full, "/analytics/overview"),
        call(true, "/admin/daily-reports/status"),
        call(full, `/admin/reports/links-analytics?startDate=${today}&endDate=${today}`),
        call(full, `/admin/reports/summary?${week}`),
        call(full, "/analytics/tasks"),
      ]);
      return {
        overview: settle(overview, parseOverview),
        poa: settle(poa, parsePoa),
        linksToday: settle(linksToday, parseLinksToday),
        top: settle(summary, parseTop),
        tasks: settle(tasks, parseTasks),
      };
    },
    [full],
    DASH_OPTIONS,
  );

  // Phase 2: started once the first paint has landed.
  const p2 = useApi<Phase2>(
    async () => {
      const [growth, apps, complaints, bugs, campaigns, watch] = await Promise.allSettled([
        call(full, "/admin/meta/channels?window=days_28"),
        call(true, "/admin/applications"),
        call(true, "/admin/complaints"),
        call(true, "/admin/bug-reports"),
        call(full, "/admin/campaigns"),
        call(full, "/admin/meta/posting-watch"),
      ]);
      return {
        growth: settle(growth, parseGrowth),
        apps: settle(apps, parseOpenApps),
        complaints: settle(complaints, parseOpenComplaints),
        bugs: settle(bugs, parseOpenBugs),
        campaigns: settle(campaigns, parseCampaignsToDo),
        watch: settle(watch, parseWatch),
      };
    },
    [full],
    { ...DASH_OPTIONS, enabled: p1.status !== "loading" },
  );

  const refresh1 = p1.refresh;
  const reload1 = p1.reload;
  const reload2 = p2.reload;
  const reloadAll = useCallback(async () => {
    await Promise.all([reload1(), reload2(), reloadCounts()]);
  }, [reload1, reload2, reloadCounts]);
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh1(), reload2(), reloadCounts()]);
  }, [refresh1, reload2, reloadCounts]);

  const today = useDayChange(() => {
    void reloadAll();
  });
  useInvalidation("approvals", reloadCounts);

  const go = (path: string) => router.push(path);
  const openApprovals = (tab?: string) => go(tab ? `/(admin)/approvals?tab=${tab}` : "/(admin)/approvals");

  const d1 = p1.data;
  const d2 = p2.data;
  const sources1: Array<Src<unknown>> = d1 ? [d1.overview, d1.poa, d1.linksToday, d1.top, d1.tasks] : [];
  const sources2: Array<Src<unknown>> = d2
    ? [d2.growth, d2.apps, d2.complaints, d2.bugs, d2.campaigns, d2.watch]
    : [];
  const tried1 = sources1.filter((s) => s.state !== "skipped");
  const allFailed = tried1.length > 0 && tried1.every((s) => s.state === "failed");
  const firstError = tried1.reduce<ErrorInfo | null>((acc, s) => acc ?? (s.state === "failed" ? s.error : null), null);
  const someFailed = [...sources1, ...sources2].some((s) => s.state === "failed");

  const ov = valueOf(d1?.overview);
  const poa = valueOf(d1?.poa);
  const linksToday = valueOf(d1?.linksToday);
  const top = valueOf(d1?.top) ?? [];
  const tasks = valueOf(d1?.tasks);

  const subtitle = [user?.name, caps.isAdmin ? "Admin" : "HR Manager", fmtDay(today)]
    .filter((s): s is string => !!s)
    .join(" · ");

  const poaRow = (
    <ListItem
      icon="clipboard-outline"
      tint="brand"
      title="Plan of action today"
      subtitle={
        d1?.poa.state === "failed" ? "Couldn't load" : poa ? `${poa.written} of ${poa.expected} written` : "—"
      }
      onPress={() => go("/admin-not-submitted?kind=poa")}
    />
  );

  const renderFull = () => {
    const watch = watchCopy(d2?.watch);
    const growthSrc = d2?.growth;
    const growth = valueOf(growthSrc);
    const yesterday = ov?.linksTrend.find((t) => t.date === addDaysISO(today, -1))?.count ?? null;
    const diff = ov?.linksToday != null && yesterday != null ? ov.linksToday - yesterday : null;
    const deltaTone: Tone = diff == null || diff === 0 ? "neutral" : diff > 0 ? "success" : "danger";
    const delta = diff == null ? undefined : { value: `${diff > 0 ? "+" : ""}${diff} vs yday`, tone: deltaTone };
    const trend = ov?.linksTrend ?? [];
    const reportsSubtitle =
      d1?.overview.state === "failed" && d1.linksToday.state === "failed"
        ? "Couldn't load"
        : `${orDash(ov?.submittedTodayCount)} submitted · ${orDash(linksToday?.notYet)} not yet`;

    return (
      <>
        <ListGroup title="Needs you">
          <ListItem
            icon="document-text-outline"
            tint="blue"
            title="Daily reports today"
            subtitle={reportsSubtitle}
            onPress={() => go("/admin-not-submitted?kind=links")}
          />
          {poaRow}
          <ListItem
            icon="eye-outline"
            tint={watch.quiet ? "red" : "pink"}
            title="Posting watch"
            subtitle={watch.text}
            onPress={() => go("/admin-posting-watch")}
          />
          <ListItem
            icon="megaphone-outline"
            tint="brand"
            title="Campaign bookings"
            subtitle={campaignCopy(d2?.campaigns)}
            onPress={() => go("/admin-campaigns")}
          />
        </ListGroup>

        <SectionTitle right={<SeeAll onPress={() => go("/admin-growth")} />}>Account growth · 28d</SectionTitle>
        {growthSrc?.state === "ok" && growth === null ? (
          <Empty compact icon="trending-up-outline" text="No Meta data in 28 days" />
        ) : (
          <>
            <StatGrid columns={2}>
              <StatTile
                label="Views"
                icon="eye-outline"
                value={growthSrc ? fmtCompact(growth?.views) : "…"}
                onPress={() => go("/admin-growth")}
              />
              <StatTile
                label="Engagements"
                icon="heart-outline"
                tone="danger"
                value={growthSrc ? fmtCompact(growth?.engagements) : "…"}
                onPress={() => go("/admin-growth")}
              />
              <StatTile
                label="Followers"
                icon="person-add-outline"
                tone="info"
                value={growthSrc ? fmtCompact(growth?.followers) : "…"}
                onPress={() => go("/admin-growth")}
              />
              <StatTile
                label="Revenue"
                icon="cash-outline"
                tone="success"
                valueColor={colors.greenText}
                value={growthSrc ? fmtUsdCents(growth?.earningsCents) : "…"}
                onPress={() => go("/admin-growth")}
              />
            </StatGrid>
            {growth?.channelCount != null ? (
              <Text maxFontSizeMultiplier={1.6} style={styles.note}>
                {growth.channelCount} connected Meta {plural(growth.channelCount, "channel", "channels")}
              </Text>
            ) : null}
          </>
        )}

        <SectionTitle right={<SeeAll onPress={() => go("/admin-employees")} />}>Team today</SectionTitle>
        <StatGrid columns={2}>
          <StatTile
            label="Employees"
            icon="people-outline"
            tone="info"
            value={orDash(ov?.totalEmployees)}
            onPress={() => go("/admin-employees")}
          />
          <StatTile
            label="Present"
            icon="checkmark-circle-outline"
            tone="success"
            value={orDash(ov?.presentToday)}
            onPress={() => go("/admin-attendance")}
          />
          <StatTile
            label="Submitted"
            icon="document-text-outline"
            value={orDash(ov?.submittedTodayCount)}
            onPress={() => go("/(admin)/reports")}
          />
          <StatTile
            label="Rate"
            icon="speedometer-outline"
            value={ov?.submissionRateToday != null ? `${ov.submissionRateToday}%` : "—"}
            progress={ov?.submissionRateToday != null ? ov.submissionRateToday / 100 : undefined}
            onPress={() => go("/(admin)/reports")}
          />
        </StatGrid>

        <SectionTitle right={<SeeAll onPress={() => go("/(admin)/reports")} />}>Links</SectionTitle>
        <StatGrid columns={3}>
          <StatTile
            compact
            label="Today"
            value={ov?.linksToday != null ? fmtCompact(ov.linksToday) : "—"}
            delta={delta}
            onPress={() => go("/(admin)/reports")}
          />
          <StatTile
            compact
            label="This week"
            value={ov?.linksThisWeek != null ? fmtCompact(ov.linksThisWeek) : "—"}
            onPress={() => go("/(admin)/reports")}
          />
          <StatTile
            compact
            label="This month"
            value={ov?.linksThisMonth != null ? fmtCompact(ov.linksThisMonth) : "—"}
            onPress={() => go("/(admin)/reports")}
          />
        </StatGrid>
        {trend.length > 1 ? (
          <Card
            onPress={() => go("/(admin)/reports")}
            accessibilityLabel={`Links over the last ${trend.length} days. Open reports`}
          >
            <TrendBars
              data={trend.map((t) => t.count)}
              accessibilityLabel={`Links per day, last ${trend.length} days`}
            />
            <View style={styles.trendFoot}>
              <Text maxFontSizeMultiplier={1.3} style={styles.trendLabel}>
                {fmtDay(trend[0].date, { weekday: false })}
              </Text>
              <Text maxFontSizeMultiplier={1.3} style={styles.trendLabel}>
                Links · last {trend.length} days
              </Text>
              <Text maxFontSizeMultiplier={1.3} style={styles.trendLabel}>
                {fmtDay(trend[trend.length - 1].date, { weekday: false })}
              </Text>
            </View>
          </Card>
        ) : null}

        {top.length > 0 ? (
          <>
            <SectionTitle right={<SeeAll onPress={() => go("/admin-leaderboard")} />}>Top performers · 7d</SectionTitle>
            <ListGroup>
              {top.map((e) => (
                <ListItem
                  key={e.id}
                  leading={<Avatar name={e.name} size={32} />}
                  title={e.name}
                  subtitle={`${e.reports} ${plural(e.reports, "report", "reports")}`}
                  detail={`${fmtCompact(e.links)} links`}
                  onPress={() => go(`/admin-employee/${e.id}?name=${encodeURIComponent(e.name)}`)}
                />
              ))}
            </ListGroup>
          </>
        ) : null}

        <SectionTitle right={<SeeAll onPress={() => go("/admin-tasks")} />}>Tasks</SectionTitle>
        <StatGrid columns={3}>
          <StatTile compact label="Open" value={orDash(tasks?.open)} onPress={() => go("/admin-tasks")} />
          <StatTile
            compact
            label="Overdue"
            value={orDash(tasks?.overdue)}
            valueColor={(tasks?.overdue ?? 0) > 0 ? colors.redText : undefined}
            onPress={() => go("/admin-tasks")}
          />
          <StatTile
            compact
            label="Done rate"
            value={tasks?.rate != null ? `${tasks.rate}%` : "—"}
            valueColor={tasks?.rate != null ? colors.greenText : undefined}
            onPress={() => go("/admin-analytics")}
          />
        </StatGrid>

        <ListGroup title="Workspace & attention">
          <ListItem
            icon="speedometer-outline"
            tint="orange"
            title="Overview"
            subtitle="Views, reach, revenue & trending"
            onPress={() => go("/admin-overview")}
          />
          <ListItem
            icon="git-branch-outline"
            tint="brand"
            title="Teams"
            detail={String(orDash(ov?.activeTeams))}
            onPress={() => go("/admin-teams")}
          />
          <ListItem
            icon="folder-outline"
            tint="teal"
            title="Projects"
            detail={String(orDash(ov?.activeProjects))}
            onPress={() => go("/admin-projects")}
          />
          <ListItem
            icon="images-outline"
            tint="pink"
            title="Content"
            subtitle="Published this month"
            detail={String(orDash(ov?.contentPublishedThisMonth))}
            onPress={() => go("/admin-content")}
          />
          <ListItem
            icon="briefcase-outline"
            tint="blue"
            title="Applications"
            {...countRow(d2?.apps)}
            onPress={() => go("/admin-jobs")}
          />
          <ListItem
            icon="alert-circle-outline"
            tint="orange"
            title="Complaints"
            {...countRow(d2?.complaints)}
            onPress={() => go("/admin-complaints")}
          />
          <ListItem
            icon="bug-outline"
            tint="red"
            title="Bugs"
            {...countRow(d2?.bugs)}
            onPress={() => go("/admin-bug-reports")}
          />
        </ListGroup>
      </>
    );
  };

  const renderHr = () => (
    <>
      <ListGroup title="Needs you">{poaRow}</ListGroup>
      <ListGroup title="People">
        {HR_PEOPLE.map((r) => (
          <ListItem key={r.path} icon={r.icon} tint={r.tint} title={r.title} onPress={() => go(r.path)} />
        ))}
      </ListGroup>
      <SectionTitle>Needs attention</SectionTitle>
      <StatGrid columns={3}>
        <StatTile compact label="Applications" value={countTile(d2?.apps)} onPress={() => go("/admin-jobs")} />
        <StatTile
          compact
          label="Complaints"
          value={countTile(d2?.complaints)}
          onPress={() => go("/admin-complaints")}
        />
        <StatTile compact label="Bugs" value={countTile(d2?.bugs)} onPress={() => go("/admin-bug-reports")} />
      </StatGrid>
    </>
  );

  return (
    <Screen header="none" onRefresh={refreshAll} refreshing={p1.refreshing}>
      <LargeTitle
        title={greetingIST()}
        subtitle={subtitle}
        right={
          <IconButton icon="notifications-outline" label="Notifications" onPress={() => go("/admin-notifications")} />
        }
      />

      <PendingCallout counts={counts} onOpen={openApprovals} onRetry={() => void reloadCounts()} />

      {d1 === null ? (
        <>
          <SkeletonStatRow count={2} />
          <SkeletonList rows={4} tile />
        </>
      ) : allFailed ? (
        <LoadFailed
          error={firstError?.message ?? "Couldn't load the dashboard."}
          code={firstError?.code}
          status={firstError?.status}
          onRetry={() => void reloadAll()}
        />
      ) : (
        <>
          {someFailed ? (
            <ErrorBanner
              message="Some numbers couldn't load"
              onRetry={() => void reloadAll()}
              style={styles.banner}
            />
          ) : null}
          {full ? renderFull() : renderHr()}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  calloutHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 44,
  },
  calloutTitle: { ...type.headline, flex: 1, color: colors.ink },
  calloutSub: { ...type.subhead, color: colors.sub, marginTop: spacing.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  chip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.card,
  },
  chipText: { ...type.subhead, fontWeight: "600" },
  calloutRetry: { marginTop: spacing.md, alignSelf: "flex-start" },
  pressed: { opacity: 0.7 },
  banner: { marginBottom: spacing.md },
  note: { ...type.footnote, color: colors.sub, marginTop: spacing.xs, marginBottom: spacing.xs },
  trendFoot: { flexDirection: "row", justifyContent: "space-between", marginTop: spacing.sm },
  trendLabel: { ...type.caption, color: colors.sub },
});
