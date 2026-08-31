import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AttendanceScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any>(() => apiFetch("/hr/attendance"));

  if (loading) return <Loading />;

  if (data && data.isEmployee === false) {
    return (
      <Screen>
        <Card>
          <Empty icon="briefcase-outline" text="Attendance isn't tracked for admin accounts" />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SectionTitle>This Month</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Workdays" value={data?.totalWorkdays ?? "—"} />
        <Stat label="Present" value={data?.present ?? "—"} accent={colors.green} />
        <Stat label="Absent" value={data?.absent ?? "—"} accent={colors.red} />
      </View>
      <View style={styles.statRow}>
        <Stat label="Late" value={data?.late ?? "—"} accent={colors.amber} />
        <Stat label="Half Days" value={data?.halfDay ?? "—"} />
        <Stat label="Rate" value={data?.rate != null ? `${data.rate}%` : "—"} accent={colors.purple} />
      </View>

      <SectionTitle>Records</SectionTitle>
      <Card>
        {(data?.records ?? []).length === 0 ? (
          <Empty icon="time-outline" text="No attendance records this month" />
        ) : (
          data.records.map((r: any, i: number) => (
            <View key={r.id ?? i} style={[styles.recRow, i === data.records.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.recDate}>{fmtDate(r.date)}</Text>
                {r.checkIn ? (
                  <Text style={styles.recTime}>
                    In {new Date(r.checkIn).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
                    {r.checkOut
                      ? ` · Out ${new Date(r.checkOut).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
                      : ""}
                  </Text>
                ) : null}
              </View>
              <StatusPill status={r.status} />
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  recDate: { fontSize: 14, fontWeight: "600", color: colors.ink },
  recTime: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
