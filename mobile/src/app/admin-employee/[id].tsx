import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { apiFetch, apiFetchPage, errorMessage, fmtCompact, fmtDateTime, fmtDay } from "@/lib/api";
import { colors, radius, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { openFile } from "@/lib/device";
import {
  Avatar,
  Button,
  Card,
  Empty,
  ErrorBanner,
  LoadFailed,
  Screen,
  SectionTitle,
  StatusPill,
  TrendBars,
} from "@/components/ui";
import { DateTile, ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { Sheet } from "@/components/sheet";
import { SkeletonCard, SkeletonStatRow } from "@/components/skeleton";

const PAGE_SIZE = 20;

type PlatformCount = { platform: string; count: number };

type EmployeeStats = {
  totalReports?: number;
  totalLinks?: number;
  currentStreak?: number;
  avgLinksPerDay?: number;
  submissionRate?: number | null;
  dailyTrend?: Array<{ linkCount?: number; count?: number }>;
  platformBreakdown?: PlatformCount[];
  bestChannel?: { platform: string } | null;
  worstChannel?: { platform: string } | null;
};

type Profile = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  profileImageUrl?: string | null;
  roles?: Array<{ role?: { name?: string | null } | null; name?: string | null }>;
};

type Assignment = {
  id: string;
  account?: {
    id: string;
    displayName?: string | null;
    handle?: string | null;
    platform?: { name?: string | null } | null;
  } | null;
};

type ReportLink = {
  id: string;
  url?: string | null;
  platform?: string | null;
  isScheduled?: boolean;
  scheduledFor?: string | null;
  account?: { displayName?: string | null; handle?: string | null; platform?: { name?: string | null } | null } | null;
};

type Report = {
  id: string;
  date: string;
  notes?: string | null;
  links?: ReportLink[];
};

type Detail = {
  stats: EmployeeStats | null;
  profile: Profile | null;
  accounts: Assignment[];
  accountsFailed: boolean;
  reports: Report[];
  reportsFailed: boolean;
  reportsPage: number;
  reportsHasMore: boolean;
};

function linkCount(r: Report): number {
  return (r.links ?? []).filter((l) => !!l.url).length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function linkTitle(l: ReportLink): string {
  return l.account?.displayName || l.account?.platform?.name || l.platform || "Link";
}

function linkSubtitle(l: ReportLink): string {
  if (l.url) return l.url;
  if (l.isScheduled || l.scheduledFor) return `Scheduled · ${fmtDateTime(l.scheduledFor)}`;
  return "No link";
}

export default function AdminEmployeeDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const state = useApi<Detail>(async () => {
    const [stats, reports, profile, accounts] = await Promise.allSettled([
      apiFetch<EmployeeStats>(`/admin/reports/employee-stats/${id}`),
      apiFetchPage<Report>(`/admin/reports?employeeId=${id}&pageSize=${PAGE_SIZE}`),
      apiFetch<Profile>(`/employees/${id}`),
      apiFetch<Assignment[]>(`/employees/${id}/accounts`),
    ]);
    // Nothing to show at all → surface the failure (LoadFailed + Retry), never a blank page.
    if (stats.status === "rejected" && profile.status === "rejected") throw stats.reason;
    return {
      stats: stats.status === "fulfilled" ? stats.value : null,
      profile: profile.status === "fulfilled" ? profile.value : null,
      accounts: accounts.status === "fulfilled" ? (accounts.value ?? []) : [],
      accountsFailed: accounts.status === "rejected",
      reports: reports.status === "fulfilled" ? reports.value.items : [],
      reportsFailed: reports.status === "rejected",
      reportsPage: 1,
      reportsHasMore: reports.status === "fulfilled" ? reports.value.meta.has_more : false,
    };
  }, [id]);

  const loadMore = async () => {
    const d = state.data;
    if (!d || moreBusy) return;
    const next = d.reportsPage + 1;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await apiFetchPage<Report>(`/admin/reports?employeeId=${id}&pageSize=${PAGE_SIZE}&page=${next}`);
      state.mutate((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.reports.map((r) => r.id));
        return {
          ...prev,
          reports: [...prev.reports, ...page.items.filter((r) => !seen.has(r.id))],
          reportsPage: next,
          reportsHasMore: page.meta.has_more,
        };
      });
    } catch (e) {
      setMoreError(errorMessage(e, "Couldn't load more reports."));
    } finally {
      setMoreBusy(false);
    }
  };

  const sheetLinks = openReport?.links ?? [];

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <Stack.Screen options={{ title: name ? String(name) : "Employee Reports" }} />

      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonStatRow count={3} />
            <SkeletonCard lines={3} />
            <SkeletonCard lines={4} />
          </>
        }
      >
        {(d) => {
          const s = d.stats;
          const prof = d.profile;
          const roles = (prof?.roles ?? [])
            .map((r) => r?.role?.name ?? r?.name ?? "")
            .filter(Boolean)
            .join(" · ");
          const trend: number[] = (s?.dailyTrend ?? []).map((t) => t.linkCount ?? t.count ?? 0);
          const platforms: PlatformCount[] = s?.platformBreakdown ?? [];
          const maxPlat = Math.max(...platforms.map((x) => x.count), 1);
          const profileSub = [prof?.email ?? prof?.phone ?? "", roles].filter(Boolean).join("\n");

          return (
            <>
              <StatGrid columns={3}>
                <StatTile compact label="Reports" value={s?.totalReports ?? "—"} />
                <StatTile compact label="Links" value={s?.totalLinks ?? "—"} valueColor={colors.purpleText} />
                <StatTile compact label="Streak" value={s?.currentStreak ?? "—"} />
              </StatGrid>
              <StatGrid columns={2}>
                <StatTile label="Avg links/day" value={s?.avgLinksPerDay ?? "—"} />
                <StatTile
                  label="Submission rate"
                  value={s?.submissionRate != null ? `${s.submissionRate}%` : "—"}
                  tone="success"
                  valueColor={colors.greenText}
                  progress={s?.submissionRate != null ? Math.min(1, Math.max(0, s.submissionRate / 100)) : undefined}
                />
              </StatGrid>

              {prof ? (
                <ListGroup title="Profile">
                  <ListItem
                    leading={<Avatar name={prof.name} uri={prof.profileImageUrl} size={40} />}
                    title={prof.name}
                    subtitle={profileSub || undefined}
                    trailing={prof.status ? <StatusPill size="sm" status={prof.status} /> : undefined}
                  />
                </ListGroup>
              ) : null}

              {d.accountsFailed ? (
                <>
                  <SectionTitle variant="grouped">Assigned accounts</SectionTitle>
                  <LoadFailed compact error="Couldn't load the assigned accounts." onRetry={() => void state.reload()} />
                </>
              ) : d.accounts.length > 0 ? (
                <ListGroup title={`Assigned accounts · ${d.accounts.length}`}>
                  {d.accounts.map((a) => (
                    <ListItem
                      key={a.id}
                      icon="at-outline"
                      tint="blue"
                      title={a.account?.displayName || a.account?.handle || "Account"}
                      subtitle={[a.account?.handle ? `@${a.account.handle}` : "", a.account?.platform?.name ?? ""]
                        .filter(Boolean)
                        .join(" · ")}
                    />
                  ))}
                </ListGroup>
              ) : (
                <>
                  <SectionTitle variant="grouped">Assigned accounts</SectionTitle>
                  <Card>
                    <Empty compact icon="at-outline" text="No accounts assigned" />
                  </Card>
                </>
              )}

              {trend.length > 1 ? (
                <>
                  <SectionTitle variant="grouped">Daily links</SectionTitle>
                  <Card>
                    <TrendBars data={trend} accessibilityLabel={`Daily links over the last ${trend.length} days`} />
                    <Text maxFontSizeMultiplier={1.6} style={styles.caption}>
                      Last {trend.length} days
                    </Text>
                  </Card>
                </>
              ) : null}

              {platforms.length > 0 ? (
                <>
                  <SectionTitle variant="grouped">Platforms</SectionTitle>
                  <Card>
                    {platforms.slice(0, 6).map((pb) => (
                      <View
                        key={pb.platform}
                        style={styles.mixRow}
                        accessible
                        accessibilityLabel={`${pb.platform}: ${pb.count} links`}
                      >
                        <Text maxFontSizeMultiplier={1.6} style={styles.mixLabel} numberOfLines={1}>
                          {pb.platform}
                        </Text>
                        <View style={styles.mixTrack}>
                          <View
                            style={[
                              styles.mixFill,
                              { width: `${Math.max(4, Math.round((pb.count / maxPlat) * 100))}%` },
                            ]}
                          />
                        </View>
                        <Text maxFontSizeMultiplier={1.3} style={styles.mixValue}>
                          {fmtCompact(pb.count)}
                        </Text>
                      </View>
                    ))}
                    {s?.bestChannel ? (
                      <Text maxFontSizeMultiplier={1.6} style={styles.channelNote}>
                        Best: {s.bestChannel.platform}
                        {s.worstChannel ? ` · Needs attention: ${s.worstChannel.platform}` : ""}
                      </Text>
                    ) : null}
                  </Card>
                </>
              ) : null}

              {d.reportsFailed ? (
                <>
                  <SectionTitle variant="grouped">Recent reports</SectionTitle>
                  <LoadFailed compact error="Couldn't load the reports." onRetry={() => void state.reload()} />
                </>
              ) : d.reports.length === 0 ? (
                <>
                  <SectionTitle variant="grouped">Recent reports</SectionTitle>
                  <Card>
                    <Empty compact icon="document-text-outline" text="No reports yet" />
                  </Card>
                </>
              ) : (
                <>
                  <ListGroup title="Recent reports">
                    {d.reports.map((r) => (
                      <ListItem
                        key={r.id}
                        leading={<DateTile date={r.date} tone="brand" />}
                        title={fmtDay(r.date, { year: true })}
                        subtitle={r.notes || undefined}
                        detail={plural(linkCount(r), "link")}
                        onPress={() => setOpenReport(r)}
                        accessibilityHint="Shows the links in this report"
                      />
                    ))}
                  </ListGroup>
                  {moreError ? <ErrorBanner message={moreError} onRetry={() => void loadMore()} /> : null}
                  {d.reportsHasMore ? (
                    <Button
                      title="Load more reports"
                      variant="tinted"
                      size="md"
                      loading={moreBusy}
                      disabled={moreBusy}
                      onPress={loadMore}
                    />
                  ) : null}
                </>
              )}
            </>
          );
        }}
      </AsyncBlock>

      <Sheet
        visible={openReport !== null}
        onClose={() => setOpenReport(null)}
        title={openReport ? fmtDay(openReport.date, { year: true }) : ""}
        subtitle={openReport ? plural(linkCount(openReport), "link") : undefined}
        detent="large"
      >
        {openReport?.notes ? (
          <Text maxFontSizeMultiplier={1.6} style={styles.notes}>
            {openReport.notes}
          </Text>
        ) : null}
        {sheetLinks.length > 0 ? (
          <ListGroup>
            {sheetLinks.map((l) => {
              const url = l.url?.trim();
              return (
                <ListItem
                  key={l.id}
                  icon={url ? "link-outline" : "time-outline"}
                  tint={url ? "brand" : "orange"}
                  title={linkTitle(l)}
                  subtitle={linkSubtitle(l)}
                  onPress={url ? () => void openFile(url) : undefined}
                  accessibilityHint={url ? "Opens the post" : undefined}
                />
              );
            })}
          </ListGroup>
        ) : (
          <Card>
            <Empty compact icon="link-outline" text="This report has no links" />
          </Card>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  caption: { ...type.caption, color: colors.sub, marginTop: spacing.sm, textAlign: "center" },
  mixRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 6 },
  mixLabel: { ...type.footnote, width: 84, color: colors.ink, textTransform: "capitalize" },
  mixTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.cardHigh, overflow: "hidden" },
  mixFill: { height: 6, borderRadius: 3, backgroundColor: colors.purple },
  mixValue: { ...type.caption, ...type.numeric, width: 48, color: colors.sub, textAlign: "right" },
  channelNote: { ...type.caption, color: colors.sub, marginTop: spacing.sm },
  notes: {
    ...type.subhead,
    color: colors.ink,
    backgroundColor: colors.surface3,
    borderRadius: radius.control,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
});
