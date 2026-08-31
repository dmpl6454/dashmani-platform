import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminProjects() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/projects?pageSize=100"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card><Empty icon="folder-outline" text="No projects" /></Card>
      ) : (
        items.map((p: any) => (
          <Card key={p.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>{p.name}</Text>
              <StatusPill status={p.status ?? ""} />
            </View>
            <Text style={styles.sub}>
              {p.client?.companyName ?? ""} {p.startDate ? `· since ${fmtDate(p.startDate)}` : ""}
            </Text>
            {p.description ? <Text style={styles.desc} numberOfLines={2}>{p.description}</Text> : null}
            <Text style={styles.meta}>
              {(p._count?.tasks ?? p.tasks?.length ?? 0)} task(s) · {(p._count?.accounts ?? p.accounts?.length ?? 0)} account(s)
            </Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 15, fontWeight: "800", color: colors.ink },
  sub: { fontSize: 12, color: colors.purple, marginTop: 3 },
  desc: { fontSize: 13, color: colors.sub, marginTop: 6 },
  meta: { fontSize: 12, color: colors.faint, marginTop: 6 },
});
