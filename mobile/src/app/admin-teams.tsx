import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminTeams() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/teams?pageSize=100"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="git-branch-outline" text="No teams yet" />
        </Card>
      ) : (
        items.map((t: any) => {
          const members = t.members ?? [];
          return (
            <Card key={t.id}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.name, { flex: 1 }]}>{t.name}</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>{t._count?.members ?? members.length} members</Text>
                </View>
              </View>
              {t.description ? <Text style={styles.desc}>{t.description}</Text> : null}
              {members.length > 0 && (
                <Text style={styles.members} numberOfLines={3}>
                  {members.map((m: any) => m.name ?? m?.user?.name ?? "").filter(Boolean).join(" · ")}
                </Text>
              )}
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 16, fontWeight: "700", color: colors.ink },
  countBadge: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  countText: { fontSize: 11, fontWeight: "700", color: colors.purpleDark },
  desc: { fontSize: 13, color: colors.sub, marginTop: 6 },
  members: { fontSize: 12, color: colors.sub, marginTop: 8, lineHeight: 18 },
});
