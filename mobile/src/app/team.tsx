import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function TeamScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any>(() => apiFetch("/hr/team"));

  if (loading) return <Loading />;

  const members = data?.members ?? [];

  if (!data?.teamName && members.length === 0) {
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        <Card>
          <Empty icon="people-outline" text="You're not assigned as a team lead" />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <Card style={{ alignItems: "center" }}>
        <Text style={styles.teamName}>{data.teamName ?? "My Team"}</Text>
        <Text style={styles.teamSub}>{members.length} member(s)</Text>
      </Card>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: spacing.md }}>
        <Stat label="Members" value={members.length} />
        <Stat label="Submission Rate" value={`${data.submissionRate ?? 0}%`} accent={colors.purple} />
      </View>

      <SectionTitle>Members</SectionTitle>
      <Card>
        {members.map((m: any, i: number) => (
          <View key={m.id} style={[styles.memberRow, i === members.length - 1 && { borderBottomWidth: 0 }]}>
            <View style={[styles.avatar]}>
              <Text style={styles.avatarLetter}>{(m.name || "?").charAt(0)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.memberName}>{m.name}</Text>
              {m.email ? <Text style={styles.memberEmail}>{m.email}</Text> : null}
            </View>
            {m.submittedToday != null ? (
              <Text style={[styles.todayFlag, { color: m.submittedToday ? colors.green : colors.red }]}>
                {m.submittedToday ? "✓ Today" : "— Today"}
              </Text>
            ) : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  teamName: { fontSize: 18, fontWeight: "800", color: colors.ink },
  teamSub: { fontSize: 13, color: colors.sub, marginTop: 2 },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    backgroundColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: { fontSize: 15, fontWeight: "800", color: colors.inkOnAccent },
  memberName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  memberEmail: { fontSize: 12, color: colors.sub },
  todayFlag: { fontSize: 12, fontWeight: "700" },
});
