import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminEmployees() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(
    () => apiFetch(`/employees?pageSize=100${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`),
    [search],
  );

  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search by name or email…"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        style={styles.search}
      />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Card>
          <Empty icon="people-outline" text="No employees found" />
        </Card>
      ) : (
        <Card>
          {items.map((e: any, i: number) => {
            const roles = (e.roles ?? [])
              .map((r: any) => r?.role?.name ?? r?.name ?? "")
              .filter(Boolean)
              .join(" · ");
            return (
              <Pressable
                key={e.id}
                onPress={() => router.push(`/admin-employee/${e.id}?name=${encodeURIComponent(e.name ?? "")}`)}
              >
                <View style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarLetter}>{(e.name || "?").charAt(0).toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {e.name}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {e.email ?? e.phone ?? ""}
                    </Text>
                    {roles ? (
                      <Text style={styles.roles} numberOfLines={1}>
                        {roles}
                      </Text>
                    ) : null}
                  </View>
                  <StatusPill status={e.status ?? ""} />
                </View>
              </Pressable>
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
    backgroundColor: colors.cardHigh,
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
  avatar: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: { fontSize: 16, fontWeight: "700", color: colors.inkOnAccent },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 1 },
  roles: { fontSize: 11, color: colors.purple, marginTop: 1 },
});
