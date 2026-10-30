import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtDay, fmtTime, istDateOf, MONTHS, todayIST } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { Card, Empty, Screen, SectionTitle, StatusPill, useApi } from "@/components/ui";
import { DateTile, ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard, SkeletonList, SkeletonStatRow } from "@/components/skeleton";

type AttendanceRecord = {
  id?: string;
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  status: string;
};

type Attendance = {
  isEmployee?: boolean;
  totalWorkdays?: number;
  present?: number;
  absent?: number;
  late?: number;
  halfDay?: number;
  rate?: number | null;
  records?: AttendanceRecord[];
};

function dayOf(v: string): string {
  return istDateOf(v) ?? String(v).slice(0, 10);
}

function timesOf(r: AttendanceRecord): string | undefined {
  if (!r.checkIn) return undefined;
  return `In ${fmtTime(r.checkIn)}${r.checkOut ? ` · Out ${fmtTime(r.checkOut)}` : ""}`;
}

function monthLabel(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return `${MONTHS[m - 1] ?? "This month"} ${y}`;
}

function TodayCard({ record, today }: { record: AttendanceRecord | undefined; today: string }) {
  let line: string;
  if (record?.checkIn) {
    line = `In ${fmtTime(record.checkIn)}${record.checkOut ? ` · Out ${fmtTime(record.checkOut)}` : " · not checked out yet"}`;
  } else if (record) {
    line = formatStatus(record.status);
  } else {
    line = "No check-in recorded yet";
  }
  return (
    <Card>
      <View style={styles.todayRow}>
        <View style={styles.flex}>
          <Text style={styles.todayLabel} maxFontSizeMultiplier={1.6}>
            Today · {fmtDay(today)}
          </Text>
          <Text style={styles.todayLine} maxFontSizeMultiplier={1.6}>
            {line}
          </Text>
        </View>
        {record ? <StatusPill status={record.status} size="sm" /> : null}
      </View>
    </Card>
  );
}

function AttendanceBody({ data }: { data: Attendance }) {
  if (data.isEmployee === false) {
    return (
      <Card>
        <Empty icon="briefcase-outline" title="Not tracked" text="Attendance isn't tracked for admin accounts." />
      </Card>
    );
  }

  const today = todayIST();
  const records = data.records ?? [];
  const todayRecord = records.find((r) => dayOf(r.date) === today);
  const rate = data.rate;

  return (
    <>
      <TodayCard record={todayRecord} today={today} />

      <SectionTitle>{monthLabel(today)}</SectionTitle>
      <StatGrid columns={3}>
        <StatTile compact label="Workdays" value={data.totalWorkdays ?? "—"} icon="calendar-outline" tone="neutral" />
        <StatTile compact label="Present" value={data.present ?? "—"} icon="checkmark-circle-outline" tone="success" />
        <StatTile compact label="Absent" value={data.absent ?? "—"} icon="close-circle-outline" tone="danger" />
        <StatTile compact label="Late" value={data.late ?? "—"} icon="time-outline" tone="warning" />
        <StatTile compact label="Half days" value={data.halfDay ?? "—"} icon="contrast-outline" tone="info" />
        <StatTile
          compact
          label="Rate"
          value={rate != null ? `${rate}%` : "—"}
          icon="trending-up-outline"
          tone="brand"
          progress={rate != null ? Math.max(0, Math.min(1, rate / 100)) : undefined}
        />
      </StatGrid>

      <SectionTitle>Records</SectionTitle>
      {records.length === 0 ? (
        <Card>
          <Empty icon="time-outline" title="No records yet" text="No attendance records this month." compact />
        </Card>
      ) : (
        <ListGroup>
          {records.map((r, i) => {
            const ymd = dayOf(r.date);
            return (
              <ListItem
                key={r.id ?? `${ymd}-${i}`}
                leading={<DateTile date={ymd} tone={ymd === today ? "brand" : "neutral"} />}
                title={fmtDay(ymd)}
                subtitle={timesOf(r)}
                trailing={<StatusPill status={r.status} size="sm" />}
              />
            );
          })}
        </ListGroup>
      )}
    </>
  );
}

export default function AttendanceScreen() {
  const state = useApi<Attendance>(() => apiFetch<Attendance>("/hr/attendance"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonCard lines={2} />
            <SkeletonStatRow count={3} />
            <SkeletonList rows={4} tile />
          </>
        }
      >
        {(d) => <AttendanceBody data={d} />}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  todayRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  todayLabel: { ...type.headline, color: colors.ink },
  todayLine: { ...type.subhead, color: colors.sub, marginTop: 2 },
});
