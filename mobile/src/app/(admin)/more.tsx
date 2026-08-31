import React from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Row, Button } from "@/components/ui";

export default function AdminMore() {
  const router = useRouter();
  const { user, logout, switchMode } = useAuth();

  const confirmLogout = () => {
    Alert.alert("Sign out", "Sign out of the admin portal?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => logout() },
    ]);
  };

  const toEmployeePortal = async () => {
    const hasHrSession = await switchMode("hr");
    if (hasHrSession) {
      router.replace("/(tabs)");
    } else {
      router.replace("/login?mode=hr");
    }
  };

  return (
    <Screen>
      <Card>
        <Text style={styles.userName}>{user?.name}</Text>
        <Text style={styles.userEmail}>{user?.email || ""}</Text>
        {(user?.roles?.length ?? 0) > 0 && <Text style={styles.userRoles}>{user!.roles.join(" · ")}</Text>}
        <View style={styles.portalBadge}>
          <Text style={styles.portalBadgeText}>ADMIN PORTAL</Text>
        </View>
      </Card>

      <SectionTitle>Shortcuts</SectionTitle>
      <Card>
        <Row icon="notifications-outline" iconColor="#FF453A" title="Notifications" onPress={() => router.push("/admin-notifications")} />
        <Row icon="swap-horizontal-outline" iconColor="#30D158" title="Switch to Employee Portal" subtitle="Your own reports, leave & tasks" onPress={toEmployeePortal} />
      </Card>

      <Button title="Sign Out" onPress={confirmLogout} variant="danger" style={{ marginTop: spacing.md }} />
      <Text style={styles.version}>Dashmani Admin App · portal.digitalsukoon.com</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  userName: { fontSize: 18, fontWeight: "700", color: colors.ink },
  userEmail: { fontSize: 13, color: colors.sub, marginTop: 2 },
  userRoles: { fontSize: 12, color: colors.purple, marginTop: 6, fontWeight: "600" },
  portalBadge: {
    alignSelf: "flex-start",
    backgroundColor: colors.purpleSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 10,
  },
  portalBadgeText: { fontSize: 10, fontWeight: "700", color: colors.purpleDark, letterSpacing: 1 },
  version: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: spacing.lg },
});
