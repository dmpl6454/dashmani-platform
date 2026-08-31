import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, StatusPill, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

const FILTERS = ["ALL", "DRAFT", "PENDING_APPROVAL", "APPROVED", "PUBLISHED"] as const;

export default function AdminContent() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("ALL");
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(
    () => apiFetch(`/content?pageSize=100${filter !== "ALL" ? `&status=${filter}` : ""}`),
    [filter],
  );

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={FILTERS} value={filter} onChange={setFilter} labels={{ ALL: "All", PENDING_APPROVAL: "Pending" }} />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card><Empty icon="images-outline" text="No content posts" /></Card>
      ) : (
        items.map((p: any) => (
          <Card key={p.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { flex: 1 }]} numberOfLines={2}>{p.title ?? p.caption ?? "Untitled"}</Text>
              <StatusPill status={p.status ?? ""} />
            </View>
            <Text style={styles.meta}>
              {p.platform?.name ?? p.platform ?? ""} {p.format ? `· ${p.format}` : ""}
              {p.scheduledFor ? ` · scheduled ${fmtDate(p.scheduledFor)}` : ""}
            </Text>
            {p.project?.name ? <Text style={styles.meta}>Project: {p.project.name}</Text> : null}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 14, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.sub, marginTop: 4 },
});
