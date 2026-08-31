import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, todayIST } from "@/lib/api";
import { colors, radius } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";
import { formatStatus } from "@/lib/theme";

export default function HolidaysScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/holidays"));

  if (loading) return <Loading />;

  const today = todayIST();
  const holidays = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {holidays.length === 0 ? (
        <Card>
          <Empty icon="sunny-outline" text="No holidays configured for this year" />
        </Card>
      ) : (
        <Card>
          {holidays.map((h: any, i: number) => {
            const past = String(h.date).slice(0, 10) < today;
            return (
              <View key={h.id} style={[styles.row, i === holidays.length - 1 && { borderBottomWidth: 0 }, past && { opacity: 0.45 }]}>
                <View style={styles.dateBox}>
                  <Text style={styles.day}>{new Date(h.date).getDate()}</Text>
                  <Text style={styles.mon}>{new Date(h.date).toLocaleDateString("en-IN", { month: "short" })}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{h.name}</Text>
                  <Text style={styles.sub}>
                    {fmtDate(h.date)}
                    {h.type ? ` · ${formatStatus(h.type)}` : ""}
                  </Text>
                  {h.description ? <Text style={styles.desc}>{h.description}</Text> : null}
                </View>
              </View>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dateBox: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.yellowSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  day: { fontSize: 17, fontWeight: "700", color: colors.ink },
  mon: { fontSize: 10, color: colors.sub },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 1 },
  desc: { fontSize: 12, color: colors.faint, marginTop: 2 },
});
