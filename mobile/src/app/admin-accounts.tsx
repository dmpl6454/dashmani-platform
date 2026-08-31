import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput } from "react-native";
import { apiFetch, fmtCompact } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminAccounts() {
  const [search, setSearch] = useState("");
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(
    () => apiFetch(`/accounts?pageSize=100${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`),
    [search],
  );

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search accounts…"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        style={styles.search}
      />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon="at-outline" text="No accounts found" />
        </Card>
      ) : (
        <Card>
          {items.map((a: any, i: number) => {
            const assignees = (a.assignments ?? [])
              .map((x: any) => x?.employee?.name ?? "")
              .filter(Boolean)
              .join(", ");
            return (
              <View key={a.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {a.displayName || a.handle}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    @{(a.handle || "").split("?")[0].replace(/^@/, "")} · {a.platform?.name ?? ""}
                  </Text>
                  {assignees ? (
                    <Text style={styles.assignees} numberOfLines={1}>
                      → {assignees}
                    </Text>
                  ) : (
                    <Text style={[styles.assignees, { color: colors.faint }]}>Unassigned</Text>
                  )}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.followers}>{fmtCompact(a.followerCount)}</Text>
                  <Text style={styles.followersLabel}>followers</Text>
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
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 1 },
  assignees: { fontSize: 11, color: colors.purple, marginTop: 2 },
  followers: { fontSize: 15, fontWeight: "800", color: colors.ink },
  followersLabel: { fontSize: 10, color: colors.sub },
});
