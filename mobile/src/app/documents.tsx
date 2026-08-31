import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

function fmtBytes(n?: number) {
  if (!n) return "";
  if (n > 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n > 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

export default function DocumentsScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/documents"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="folder-open-outline" text="No documents uploaded yet" />
        </Card>
      ) : (
        <Card>
          {items.map((d: any, i: number) => (
            <View key={d.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>{d.fileName ?? d.name}</Text>
                <Text style={styles.sub}>
                  {fmtBytes(d.fileSize)} · {fmtDate(d.createdAt)}
                </Text>
                {d.reviewNotes ? <Text style={styles.notes} numberOfLines={2}>Note: {d.reviewNotes}</Text> : null}
              </View>
              <StatusPill status={d.status ?? "PENDING"} />
            </View>
          ))}
        </Card>
      )}
      <Text style={styles.hint}>Upload new documents from the web portal at hr.digitalsukoon.com/documents</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  notes: { fontSize: 11, color: colors.amber, marginTop: 2 },
  hint: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: 4 },
});
