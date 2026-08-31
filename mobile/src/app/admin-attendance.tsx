import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, todayIST, daysAgoIST } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

const WINDOWS = ["TODAY", "7D", "30D"] as const;
type Win = (typeof WINDOWS)[number];

export default function AdminAttendance() {
  const [win, setWin] = useState<Win>("TODAY");
  const startDate = win === "TODAY" ? todayIST() : win === "7D" ? daysAgoIST(6) : daysAgoIST(29);
  const endDate = todayIST();

  const { data, loading, refreshing, error, refresh } = useApi<any>(
    () => apiFetch(`/attendance?startDate=${startDate}&endDate=${endDate}&pageSize=100`),
    [win],
  );

  const records: any[] = Array.isArray(data) ? data : data?.items ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={WINDOWS} value={win} onChange={setWin} labels={{ TODAY: "Today", "7D": "7 days", "30D": "30 days" }} />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <SectionTitle>Records ({records.length})</SectionTitle>
          <Card>
            {records.length === 0 ? (
              <Empty icon="time-outline" text="No attendance records in this window" />
            ) : (
              records.map((r: any, i: number) => (
                <View key={r.id ?? i} style={[styles.row, i === records.length - 1 && { borderBottomWidth: 0 }]}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {r.employee?.name ?? r.user?.name ?? "Employee"}
                    </Text>
                    <Text style={styles.sub}>
                      {fmtDate(r.date)}
                      {r.checkIn
                        ? ` · In ${new Date(r.checkIn).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
                        : ""}
                      {r.checkOut
                        ? ` · Out ${new Date(r.checkOut).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`
                        : ""}
                    </Text>
                  </View>
                  <StatusPill status={r.status ?? ""} />
                </View>
              ))
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
