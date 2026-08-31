import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, radius } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminClients() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/clients?pageSize=100"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card><Empty icon="business-outline" text="No clients" /></Card>
      ) : (
        <Card>
          {items.map((c: any, i: number) => (
            <View key={c.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={styles.avatar}>
                <Text style={styles.avatarLetter}>{(c.companyName || "?").charAt(0).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.name} numberOfLines={1}>{c.companyName}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {c.contactName ?? ""} {c.email ? `· ${c.email}` : ""}
                </Text>
                <Text style={styles.meta}>{(c._count?.projects ?? c.projects?.length ?? 0)} project(s)</Text>
              </View>
              <StatusPill status={c.status ?? "ACTIVE"} />
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  avatar: { width: 38, height: 38, borderRadius: radius.md, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center" },
  avatarLetter: { fontSize: 16, fontWeight: "800", color: colors.blue },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 1 },
  meta: { fontSize: 11, color: colors.faint, marginTop: 1 },
});
