import React from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Row, Button } from "@/components/ui";

export default function MoreScreen() {
  const router = useRouter();
  const { user, logout, switchMode } = useAuth();

  const confirmLogout = () => {
    Alert.alert("Sign out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => logout() },
    ]);
  };

  const toAdminPortal = async () => {
    const hasAdminSession = await switchMode("admin");
    if (hasAdminSession) {
      router.replace("/(admin)");
    } else {
      router.replace("/login?mode=admin");
    }
  };

  return (
    <Screen>
      <Card>
        <Text style={styles.userName}>{user?.name}</Text>
        <Text style={styles.userEmail}>{user?.email || user?.phone || ""}</Text>
        {(user?.roles?.length ?? 0) > 0 && <Text style={styles.userRoles}>{user!.roles.join(" · ")}</Text>}
      </Card>

      <SectionTitle>My Work</SectionTitle>
      <Card>
        <Row icon="person-outline" title="My Profile" subtitle="Personal, bank & documents info" onPress={() => router.push("/profile")} />
        <Row icon="time-outline" title="Attendance" subtitle="Monthly attendance & records" onPress={() => router.push("/attendance")} />
        <Row icon="cash-outline" title="Salary Slips" subtitle="Monthly payslips" onPress={() => router.push("/salary-slips")} />
        <Row icon="trophy-outline" title="Leaderboard" subtitle="Team performance ranking" onPress={() => router.push("/leaderboard")} />
        <Row icon="people-outline" title="My Team" subtitle="Team dashboard (leads)" onPress={() => router.push("/team")} />
        <Row icon="sunny-outline" title="Holidays" subtitle="Company holiday calendar" onPress={() => router.push("/holidays")} />
      </Card>

      <SectionTitle>Requests & Claims</SectionTitle>
      <Card>
        <Row icon="wallet-outline" title="Expense Claims" subtitle="Submit & track reimbursements" onPress={() => router.push("/expenses")} />
        <Row icon="hourglass-outline" title="Extra Hours" subtitle="Log overtime for approval" onPress={() => router.push("/extra-hours")} />
        <Row icon="gift-outline" title="Incentives" subtitle="Bonuses awarded to you" onPress={() => router.push("/incentives")} />
        <Row icon="star-outline" title="Performance Reviews" subtitle="Your review history" onPress={() => router.push("/reviews")} />
      </Card>

      <SectionTitle>Support</SectionTitle>
      <Card>
        <Row icon="notifications-outline" title="Notifications" onPress={() => router.push("/notifications")} />
        <Row icon="megaphone-outline" title="Complaints" subtitle="Raise a workplace concern" onPress={() => router.push("/complaints")} />
        <Row icon="bug-outline" title="Report a Bug" subtitle="Something broken in the portal?" onPress={() => router.push("/bug-report")} />
        <Row icon="key-outline" title="Change Password" onPress={() => router.push("/change-password")} />
        <Row
          icon="swap-horizontal-outline"
          title="Switch to Admin Portal"
          subtitle="For admins — team reports & approvals"
          onPress={toAdminPortal}
        />
      </Card>

      <Button title="Sign Out" onPress={confirmLogout} variant="danger" style={{ marginTop: spacing.md }} />
      <Text style={styles.version}>Dashmani Employee App · hr.digitalsukoon.com</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  userName: { fontSize: 18, fontWeight: "800", color: colors.ink },
  userEmail: { fontSize: 13, color: colors.sub, marginTop: 2 },
  userRoles: { fontSize: 12, color: colors.purple, marginTop: 6, fontWeight: "600" },
  version: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: spacing.lg },
});
