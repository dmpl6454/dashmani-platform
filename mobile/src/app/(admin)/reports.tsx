import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch, daysAgoIST, fmtCompact, fmtRange, todayIST, withQuery } from "@/lib/api";
import { colors, radius, spacing, type } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { Avatar, Card, Empty, Screen, SectionTitle, SegmentedControl, useApi } from "@/components/ui";
import { LargeTitle, ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock, AsyncList } from "@/components/async";
import { SkeletonStatRow } from "@/components/skeleton";

const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
type Win = (typeof WINDOWS)[number];
const WIN_DAYS: Record<Win, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const WIN_LABELS: Record<Win, string> = { "24h": "24h", "7d": "7 days", "30d": "30 days", "90d": "90 days" };

const VIEWS = ["REPORTED", "NOT_REPORTED"] as const;
type View_ = (typeof VIEWS)[number];
const VIEW_LABELS: Record<View_, string> = { REPORTED: "Reported", NOT_REPORTED: "Not reported" };

type PlatformCount = { platform?: string | null; count?: number | null; linkCount?: number | null };

type SummaryEmployee = {
  id?: string;
  employeeId?: string;
  name?: string | null;
  employeeName?: string | null;
  profileImageUrl?: string | null;
  reportCount?: number | null;
  totalLinks?: number | null;
  linksToday?: number | null;
  platformBreakdown?: PlatformCount[] | null;
};

type Summary = {
  employeesReporting?: number | null;
  totalReports?: number | null;
  totalLinks?: number | null;
  platformBreakdown?: PlatformCount[] | null;
  employees?: SummaryEmployee[] | null;
};

type NonSubmitter = { employeeId?: string; id?: string; name?: string | null };
type LinksAnalytics = { nonSubmitters?: NonSubmitter[] | null };

function countOf(p: PlatformCount): number {
  return p.count ?? p.linkCount ?? 0;
}

/** Team platform mix (top 6): the summary's own breakdown, else aggregated per employee. */
function platformMixOf(data: Summary): Array<[string, number]> {
  const map: Record<string, number> = {};
  const top = data.platformBreakdown ?? [];
  if (top.length > 0) {
    for (const pb of top) {
      const k = String(pb.platform ?? "?").toLowerCase();
      map[k] = (map[k] || 0) + countOf(pb);
    }
  } else {
    for (const e of data.employees ?? []) {
      for (const pb of e.platformBreakdown ?? []) {
        const k = String(pb.platform ?? "?").toLowerCase();
        map[k] = (map[k] || 0) + countOf(pb);
      }
    }
  }
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function AdminReports() {
  const router = useRouter();
  const { caps } = useAuth();
  const [win, setWin] = useState<Win>("7d");
  const [view, setView] = useState<View_>("REPORTED");

  const startDate = daysAgoIST(WIN_DAYS[win] - 1);
  const endDate = todayIST();
  // Non-submitters come from an admin-only analytics route; HR-only users never see the toggle.
  const canSeeNonSubmitters = caps.isAdmin;
  const activeView: View_ = canSeeNonSubmitters ? view : "REPORTED";

  const summary = useApi<Summary>(
    () => apiFetch<Summary>(`/admin/reports/summary?startDate=${startDate}&endDate=${endDate}`),
    [win],
    { keepData: true },
  );

  const notReported = useApi<NonSubmitter[]>(
    async () => {
      const r = await apiFetch<LinksAnalytics | null>(
        withQuery("/admin/reports/links-analytics", { startDate, endDate }),
      );
      return r?.nonSubmitters ?? [];
    },
    [win],
    { keepData: true, enabled: canSeeNonSubmitters && activeView === "NOT_REPORTED" },
  );

  const openEmployee = (id: string, name: string) => {
    router.push(`/admin-employee/${id}?name=${encodeURIComponent(name)}`);
  };

  const onRefresh = async () => {
    await Promise.all([summary.refresh(), activeView === "NOT_REPORTED" ? notReported.refresh() : Promise.resolve()]);
  };

  const summaryDim = summary.fetching && summary.data !== null;
  const notReportedDim = notReported.fetching && notReported.data !== null;

  const renderReported = (data: Summary) => {
    const employees = (data.employees ?? []).slice().sort((a, b) => (b.totalLinks ?? 0) - (a.totalLinks ?? 0));
    if (employees.length === 0) {
      return <Empty icon="bar-chart-outline" title="No reports yet" text="No one has filed a report in this window." />;
    }
    return (
      <ListGroup>
        {employees.map((e, i) => {
          const id = e.employeeId ?? e.id;
          const name = e.employeeName ?? e.name ?? "Employee";
          const reports = e.reportCount ?? 0;
          const subtitle = `${plural(reports, "report")}${e.linksToday != null ? ` · ${e.linksToday} today` : ""}`;
          return (
            <ListItem
              key={id ?? `emp-${i}`}
              leading={<Avatar name={name} uri={e.profileImageUrl} ring={i < 3} />}
              title={`${i + 1}. ${name}`}
              subtitle={subtitle}
              detail={`${fmtCompact(e.totalLinks ?? 0)} links`}
              onPress={id ? () => openEmployee(id, name) : undefined}
              accessibilityLabel={`Rank ${i + 1}, ${name}, ${subtitle}, ${e.totalLinks ?? 0} links`}
            />
          );
        })}
      </ListGroup>
    );
  };

  return (
    <Screen header="none" onRefresh={onRefresh} refreshing={summary.refreshing || notReported.refreshing}>
      <LargeTitle title="Reports" subtitle={fmtRange(startDate, endDate)} />
      <SegmentedControl options={WINDOWS} value={win} onChange={setWin} labels={WIN_LABELS} style={styles.control} />

      <AsyncBlock
        state={summary}
        skeleton={
          <View style={styles.skeleton}>
            <SkeletonStatRow count={3} />
          </View>
        }
      >
        {(data) => {
          const mix = platformMixOf(data);
          const max = mix.length > 0 ? mix[0][1] || 1 : 1;
          return (
            <View style={summaryDim ? styles.dim : null}>
              <StatGrid columns={3}>
                <StatTile key="reporting" compact label="Reporting" value={data.employeesReporting ?? 0} icon="people-outline" />
                <StatTile key="reports" compact label="Reports" value={data.totalReports ?? 0} icon="document-text-outline" tone="info" />
                <StatTile key="links" compact label="Links" value={fmtCompact(data.totalLinks ?? 0)} icon="link-outline" tone="success" />
              </StatGrid>

              {mix.length > 0 ? (
                <>
                  <SectionTitle>Platform mix</SectionTitle>
                  <Card>
                    {mix.map(([platform, count]) => (
                      <View
                        key={platform}
                        style={styles.mixRow}
                        accessible
                        accessibilityLabel={`${platform}, ${count} links`}
                      >
                        <Text maxFontSizeMultiplier={1.4} style={styles.mixLabel} numberOfLines={1}>
                          {platform}
                        </Text>
                        <View style={styles.mixTrack}>
                          <View
                            style={[styles.mixFill, { width: `${Math.max(4, Math.round((count / max) * 100))}%` }]}
                          />
                        </View>
                        <Text maxFontSizeMultiplier={1.4} style={styles.mixValue}>
                          {fmtCompact(count)}
                        </Text>
                      </View>
                    ))}
                  </Card>
                </>
              ) : null}
            </View>
          );
        }}
      </AsyncBlock>

      <SectionTitle>People</SectionTitle>
      {canSeeNonSubmitters ? (
        <SegmentedControl options={VIEWS} value={activeView} onChange={setView} labels={VIEW_LABELS} style={styles.control} />
      ) : null}

      {activeView === "REPORTED" ? (
        summary.data !== null ? (
          <View style={summaryDim ? styles.dim : null}>{renderReported(summary.data)}</View>
        ) : null
      ) : (
        <View style={notReportedDim ? styles.dim : null}>
          <AsyncList
            state={notReported}
            grouped
            keyExtractor={(e, i) => e.employeeId ?? e.id ?? `non-${i}`}
            empty={{
              icon: "checkmark-done-outline",
              title: "Everyone reported",
              text: "Every active employee filed at least one report in this window.",
              tone: "success",
            }}
            renderItem={(e) => {
              const id = e.employeeId ?? e.id;
              const name = e.name || "Employee";
              return (
                <ListItem
                  leading={<Avatar name={name} />}
                  title={name}
                  subtitle="No report in this window"
                  onPress={id ? () => openEmployee(id, name) : undefined}
                />
              );
            }}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  control: { marginBottom: spacing.md },
  skeleton: { marginBottom: spacing.md },
  dim: { opacity: 0.55 },
  mixRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 6 },
  mixLabel: { ...type.footnote, width: 88, color: colors.ink, textTransform: "capitalize" },
  mixTrack: { flex: 1, height: 6, borderRadius: radius.full, backgroundColor: colors.cardHigh, overflow: "hidden" },
  mixFill: { height: 6, borderRadius: radius.full, backgroundColor: colors.purple },
  mixValue: { ...type.caption, ...type.numeric, width: 48, color: colors.sub, textAlign: "right" },
});
