import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, Loading, ErrorBanner, useApi } from "@/components/ui";

const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export default function CalendarScreen() {
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });

  const { data, loading, refreshing, error, refresh } = useApi<any>(
    () => apiFetch(`/hr/calendar?year=${ym.y}&month=${ym.m}`),
    [ym.y, ym.m],
  );

  const shift = (d: number) => {
    let m = ym.m + d, y = ym.y;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    setYm({ y, m });
  };

  const days: any[] = data?.days ?? [];
  // Monday-first offset for the 1st of the month
  const first = new Date(ym.y, ym.m - 1, 1).getDay(); // 0=Sun
  const lead = (first + 6) % 7;
  const monthName = new Date(ym.y, ym.m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={styles.nav}>
        <Pressable onPress={() => shift(-1)} hitSlop={10} style={styles.navBtn}>
          <Ionicons name="chevron-back" size={18} color={colors.ink} />
        </Pressable>
        <Text style={styles.month}>{monthName}</Text>
        <Pressable onPress={() => shift(1)} hitSlop={10} style={styles.navBtn}>
          <Ionicons name="chevron-forward" size={18} color={colors.ink} />
        </Pressable>
      </View>
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : (
        <>
          <Card>
            <View style={styles.grid}>
              {DOW.map((d) => (
                <Text key={d} style={styles.dow}>{d}</Text>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <View key={`x${i}`} style={styles.cell} />
              ))}
              {days.map((d: any) => {
                const dayNum = Number(String(d.date).slice(8, 10));
                const leaveApproved = d.isLeave && (d.leaveStatus === "APPROVED" || !d.leaveStatus);
                const leavePending = d.isLeave && d.leaveStatus === "PENDING";
                return (
                  <View
                    key={d.date}
                    style={[
                      styles.cell,
                      d.isHoliday && { backgroundColor: colors.yellowSoft },
                      leaveApproved && { backgroundColor: colors.purpleSoft },
                      leavePending && { backgroundColor: colors.amberSoft },
                    ]}
                  >
                    <Text style={[styles.dayNum, d.isWeekend && { color: colors.faint }]}>{dayNum}</Text>
                    {d.isHoliday ? <View style={[styles.dot, { backgroundColor: colors.yellow }]} /> : null}
                    {d.isLeave ? (
                      <View style={[styles.dot, { backgroundColor: leavePending ? colors.amber : colors.purple }]} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </Card>

          <Card>
            <View style={styles.legendRow}><View style={[styles.dot, { backgroundColor: colors.yellow }]} /><Text style={styles.legend}>Holiday</Text></View>
            <View style={styles.legendRow}><View style={[styles.dot, { backgroundColor: colors.purple }]} /><Text style={styles.legend}>Approved leave</Text></View>
            <View style={styles.legendRow}><View style={[styles.dot, { backgroundColor: colors.amber }]} /><Text style={styles.legend}>Pending leave</Text></View>
            <Text style={styles.workdays}>
              {data?.workingDays ?? "—"} working days this month · Sundays off
            </Text>
          </Card>

          {(data?.holidays ?? []).length > 0 && (
            <Card>
              {data.holidays.map((h: any, i: number) => (
                <View key={h.id ?? i} style={[styles.holRow, i === data.holidays.length - 1 && { borderBottomWidth: 0 }]}>
                  <Text style={styles.holDate}>{String(h.date).slice(8, 10)}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.holName}>{h.name}</Text>
                    {h.type ? <Text style={styles.holType}>{formatStatus(h.type)}</Text> : null}
                  </View>
                </View>
              ))}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  navBtn: { width: 38, height: 38, borderRadius: radius.full, backgroundColor: colors.cardHigh, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  month: { fontSize: 17, fontWeight: "800", color: colors.ink },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  dow: { width: `${100 / 7}%`, textAlign: "center", fontSize: 11, fontWeight: "700", color: colors.sub, marginBottom: 6 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  dayNum: { fontSize: 13, fontWeight: "600", color: colors.ink },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 2 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  legend: { fontSize: 13, color: colors.ink },
  workdays: { fontSize: 12, color: colors.sub, marginTop: 6 },
  holRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  holDate: { width: 30, fontSize: 16, fontWeight: "800", color: colors.yellow, textAlign: "center" },
  holName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  holType: { fontSize: 11, color: colors.sub },
});
