import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate, fmtDateTime, daysAgoIST, todayIST } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

const WINDOWS = ["7D", "30D", "90D"] as const;
type Win = (typeof WINDOWS)[number];
const DAYS: Record<Win, number> = { "7D": 7, "30D": 30, "90D": 90 };

export default function HistoryScreen() {
  const [win, setWin] = useState<Win>("30D");
  const [open, setOpen] = useState<string | null>(null);

  const { data, loading, refreshing, error, refresh } = useApi<any[]>(
    () => apiFetch(`/hr/reports?startDate=${daysAgoIST(DAYS[win] - 1)}&endDate=${todayIST()}`),
    [win],
  );

  const reports = data ?? [];
  const totalLinks = reports.reduce((s, r) => s + (r.links ?? []).filter((l: any) => l.url).length, 0);

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={WINDOWS} value={win} onChange={setWin} labels={{ "7D": "7 days", "30D": "30 days", "90D": "90 days" }} />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : reports.length === 0 ? (
        <Card>
          <Empty icon="document-text-outline" text="No reports in this window" />
        </Card>
      ) : (
        <>
          <Text style={styles.summary}>
            {reports.length} report(s) · {totalLinks} link(s)
          </Text>
          {reports.map((r: any) => {
            const links = (r.links ?? []).filter((l: any) => l.url);
            const expanded = open === r.id;
            return (
              <Card key={r.id}>
                <Pressable onPress={() => setOpen(expanded ? null : r.id)}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.date}>{fmtDate(r.date)}</Text>
                      <Text style={styles.meta}>
                        {links.length} link(s) · submitted {fmtDateTime(r.submittedAt)}
                      </Text>
                    </View>
                    <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.sub} />
                  </View>
                </Pressable>
                {expanded && (
                  <View style={{ marginTop: spacing.sm }}>
                    {links.map((l: any, i: number) => (
                      <View key={l.id ?? i} style={styles.linkRow}>
                        <Text style={styles.linkIdx}>{i + 1}</Text>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.linkUrl} numberOfLines={1}>{l.url}</Text>
                          {l.accountName ? <Text style={styles.linkAcc} numberOfLines={1}>{l.accountName} · {l.platform}</Text> : null}
                        </View>
                      </View>
                    ))}
                    {r.notes ? <Text style={styles.notes}>Note: {r.notes}</Text> : null}
                  </View>
                )}
              </Card>
            );
          })}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 12, color: colors.sub, marginBottom: spacing.sm },
  date: { fontSize: 15, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.sub, marginTop: 2 },
  linkRow: { flexDirection: "row", gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  linkIdx: { width: 18, fontSize: 11, color: colors.faint, textAlign: "center", marginTop: 1 },
  linkUrl: { fontSize: 12, color: colors.purple },
  linkAcc: { fontSize: 11, color: colors.sub, marginTop: 1 },
  notes: { fontSize: 12, color: colors.sub, marginTop: 8, fontStyle: "italic" },
});
