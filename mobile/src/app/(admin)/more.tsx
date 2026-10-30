import React from "react";
import { Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Screen } from "@/components/ui";
import { LargeTitle, ListGroup, ListItem } from "@/components/list";
import { confirm } from "@/components/feedback";
import { PipelineEntryRow } from "@/components/pipeline";

export default function AdminMore() {
  const router = useRouter();
  const { user, logout, switchMode } = useAuth();
  const roles = user?.roles ?? [];
  const profileSubtitle = [user?.email, roles.length > 0 ? roles.join(", ") : null]
    .filter((s): s is string => !!s)
    .join(" · ");

  const signOut = async () => {
    const ok = await confirm({
      title: "Sign out",
      message: "Sign out of the admin portal?",
      confirmLabel: "Sign out",
      destructive: true,
    });
    if (ok) await logout();
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
    <Screen header="none">
      <LargeTitle title="More" subtitle="Admin portal" />

      <ListGroup>
        <ListItem
          leading={<Avatar name={user?.name ?? ""} uri={user?.profileImageUrl} size={48} ring />}
          title={user?.name ?? "Signed in"}
          subtitle={profileSubtitle || undefined}
        />
      </ListGroup>

      <ListGroup>
        <ListItem
          icon="notifications-outline"
          tint="red"
          title="Notifications"
          onPress={() => router.push("/admin-notifications")}
        />
        {/* Pipeline runs on the HR session: shown only when this person is also signed in there. */}
        <PipelineEntryRow />
        <ListItem
          icon="swap-horizontal-outline"
          tint="green"
          title="Switch to Employee Portal"
          subtitle="Your own reports, leave & tasks"
          onPress={() => void toEmployeePortal()}
        />
      </ListGroup>

      <ListGroup>
        <ListItem
          icon="log-out-outline"
          tint="red"
          title="Sign out"
          destructive
          chevron={false}
          onPress={() => void signOut()}
        />
      </ListGroup>

      <Text maxFontSizeMultiplier={1.6} style={styles.version}>
        Dashmani Admin App · portal.digitalsukoon.com
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  version: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.lg },
});
