// Admin · Not submitted — who hasn't sent today's (or yesterday's) daily report links or
// plan of action. Links need an admin (reports.view is global-only); HR sees plan of action.
//
// API: GET /admin/reports/links-analytics?startDate=D&endDate=D  → nonSubmitters {employeeId,name}
//      GET /admin/daily-reports/status?date=D                     → nonSubmitters {id,name,email}
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { addDaysISO, apiFetch, fmtDay, withQuery } from "@/lib/api";
import { colors, sizes, spacing, type } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { useDayChange } from "@/lib/hooks/shared";
import { Avatar, Chips, Screen, SegmentedControl, useApi } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type Kind = "links" | "poa";
type Day = "TODAY" | "YESTERDAY";

const KINDS = ["links", "poa"] as const;
const DAYS = ["TODAY", "YESTERDAY"] as const;
const KIND_LABELS: Record<Kind, string> = { links: "Daily report links", poa: "Plan of action" };

type Person = { id: string; name: string; email?: string | null };

type LinksAnalytics = {
  nonSubmitters?: Array<{ employeeId: string; name: string }>;
};

type PoaStatus = {
  date?: string;
  totalEmployees?: number;
  submittedCount?: number;
  nonSubmitters?: Array<{ id: string; name: string; email?: string | null }>;
};

function byName(a: Person, b: Person): number {
  return a.name.localeCompare(b.name);
}

export default function AdminNotSubmitted() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const { caps, loading: authLoading } = useAuth();

  const [requested, setRequested] = useState<Kind | null>(
    params.kind === "links" || params.kind === "poa" ? params.kind : null,
  );
  const [day, setDay] = useState<Day>("TODAY");
  const today = useDayChange(() => undefined);

  // Links analytics is admin-only; everyone else gets the plan-of-action view.
  const kind: Kind = caps.isAdmin ? requested ?? "links" : "poa";
  const date = day === "TODAY" ? today : addDaysISO(today, -1);
  const key = `${kind}:${date}`;

  // Total expected submitters for the answer currently shown (POA reports it; links does not).
  const [summary, setSummary] = useState<{ key: string; total: number | null } | null>(null);

  const people = useApi<Person[]>(
    async () => {
      if (kind === "links") {
        const d = await apiFetch<LinksAnalytics>(
          withQuery("/admin/reports/links-analytics", { startDate: date, endDate: date }),
        );
        setSummary({ key, total: null });
        return (d.nonSubmitters ?? []).map((n) => ({ id: n.employeeId, name: n.name })).sort(byName);
      }
      const d = await apiFetch<PoaStatus>(withQuery("/admin/daily-reports/status", { date }));
      setSummary({ key, total: typeof d.totalEmployees === "number" ? d.totalEmployees : null });
      return (d.nonSubmitters ?? []).map((n) => ({ id: n.id, name: n.name, email: n.email ?? null }));
    },
    [kind, date],
    { enabled: !authLoading },
  );

  const missing = people.data ? people.data.length : null;
  const total = summary && summary.key === key ? summary.total : null;
  const what = kind === "links" ? "sent their links" : "written a plan of action";
  const summaryText =
    missing === null || missing === 0
      ? null
      : total !== null
        ? `${missing} of ${total} haven't ${what}`
        : `${missing} ${missing === 1 ? "person hasn't" : "people haven't"} ${what}`;

  return (
    <Screen onRefresh={people.refresh} refreshing={people.refreshing}>
      <Stack.Screen options={{ title: "Not submitted today" }} />
      <AsyncList<Person>
        state={people}
        grouped
        header={
          <View style={styles.header}>
            {caps.isAdmin ? (
              <SegmentedControl
                options={KINDS}
                value={kind}
                onChange={setRequested}
                labels={KIND_LABELS}
                style={styles.control}
              />
            ) : null}
            <Chips
              options={DAYS}
              value={day}
              onChange={setDay}
              labels={{ TODAY: "Today", YESTERDAY: "Yesterday" }}
              mode="pills"
              accessibilityLabel="Day"
            />
            <Text style={styles.dayLine}>
              {KIND_LABELS[kind]} · {fmtDay(date, { weekday: true })}
            </Text>
            {summaryText ? (
              <Text style={styles.summary} accessibilityRole="header">
                {summaryText}
              </Text>
            ) : null}
          </View>
        }
        keyExtractor={(p) => p.id}
        empty={{
          icon: "checkmark-done-circle-outline",
          tone: "success",
          title: "Everyone has submitted",
          text:
            kind === "links"
              ? `Every active employee sent their links for ${fmtDay(date)}.`
              : `Every plan of action for ${fmtDay(date)} is in.`,
        }}
        renderItem={(p) => (
          <ListItem
            leading={<Avatar name={p.name} size={sizes.iconTile} />}
            title={p.name}
            subtitle={p.email ?? undefined}
            chevron
            onPress={() => router.push({ pathname: "/admin-employee/[id]", params: { id: p.id, name: p.name } })}
            accessibilityHint="Opens this employee's reports"
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.md, marginBottom: spacing.md },
  control: { marginBottom: spacing.xs },
  dayLine: { ...type.footnote, color: colors.sub },
  summary: { ...type.headline, color: colors.ink },
});
