import React from "react";
import { StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useBadges } from "@/lib/hooks/shared";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Screen } from "@/components/ui";
import { LargeTitle, ListGroup, ListItem } from "@/components/list";
import { confirm } from "@/components/feedback";
import { PipelineEntryRow } from "@/components/pipeline";

export default function MoreScreen() {
  const router = useRouter();
  const { user, caps, logout, switchMode } = useAuth();
  const { unread } = useBadges();

  const signOut = async () => {
    const ok = await confirm({ title: "Sign out?", confirmLabel: "Sign Out", destructive: true });
    if (ok) await logout();
  };

  const toAdminPortal = async () => {
    const hasAdminSession = await switchMode("admin");
    if (hasAdminSession) {
      router.replace("/(admin)");
    } else {
      router.replace("/login?mode=admin");
    }
  };

  const contact = user?.email || user?.phone || "";
  const roles = (user?.roles ?? []).join(" · ");
  const profileSubtitle = [contact, roles].filter(Boolean).join("\n");

  return (
    <Screen header="none">
      <LargeTitle title="More" />

      <ListGroup>
        <ListItem
          leading={<Avatar name={user?.name ?? ""} uri={user?.profileImageUrl} size={48} />}
          title={user?.name ?? "My profile"}
          subtitle={profileSubtitle || undefined}
          onPress={() => router.push("/profile")}
          accessibilityHint="Opens your profile"
        />
      </ListGroup>

      <ListGroup title="My work">
        <ListItem icon="person-outline" tint="blue" title="My Profile" subtitle="Personal, bank & documents info" onPress={() => router.push("/profile")} />
        <ListItem icon="time-outline" tint="orange" title="Attendance" subtitle="Monthly attendance & records" onPress={() => router.push("/attendance")} />
        <ListItem icon="cash-outline" tint="green" title="Salary Slips" subtitle="Monthly payslips" onPress={() => router.push("/salary-slips")} />
        <ListItem icon="trophy-outline" tint="yellow" title="Leaderboard" subtitle="Team performance ranking" onPress={() => router.push("/leaderboard")} />
        <ListItem icon="people-outline" tint="blue" title="My Team" subtitle="Team dashboard (leads)" onPress={() => router.push("/team")} />
        <ListItem icon="sunny-outline" tint="orange" title="Holidays" subtitle="Company holiday calendar" onPress={() => router.push("/holidays")} />
        <ListItem icon="calendar-number-outline" tint="red" title="Calendar" subtitle="Month view — holidays & your leaves" onPress={() => router.push("/calendar")} />
        <ListItem icon="documents-outline" tint="teal" title="Report History" subtitle="Your past daily reports" onPress={() => router.push("/history")} />
        <ListItem icon="clipboard-outline" tint="pink" title="Plan of Action" subtitle="Today's POA + past plans" onPress={() => router.push("/plan")} />
        <PipelineEntryRow />
      </ListGroup>

      <ListGroup title="Requests & claims">
        <ListItem icon="wallet-outline" tint="green" title="Expense Claims" subtitle="Submit & track reimbursements" onPress={() => router.push("/expenses")} />
        <ListItem icon="hourglass-outline" tint="orange" title="Extra Hours" subtitle="Log overtime for approval" onPress={() => router.push("/extra-hours")} />
        <ListItem icon="gift-outline" tint="pink" title="Incentives" subtitle="Bonuses awarded to you" onPress={() => router.push("/incentives")} />
        <ListItem icon="star-outline" tint="yellow" title="Performance Reviews" subtitle="Your review history" onPress={() => router.push("/reviews")} />
      </ListGroup>

      <ListGroup title="Documents & letters">
        <ListItem icon="folder-open-outline" tint="teal" title="My Documents" subtitle="Uploaded documents & review status" onPress={() => router.push("/documents")} />
        <ListItem icon="mail-open-outline" tint="blue" title="Offer Letters" subtitle="Offer & appointment letters" onPress={() => router.push("/offer-letters")} />
        <ListItem icon="document-lock-outline" tint="gray" title="Employment Contract" subtitle="View & digitally agree" onPress={() => router.push("/contract")} />
        <ListItem icon="easel-outline" tint="pink" title="Presentations" subtitle="Your saved decks" onPress={() => router.push("/presentations")} />
        <ListItem icon="calendar-outline" tint="red" title="Joining Date" subtitle="Set & track approval" onPress={() => router.push("/joining-date")} />
      </ListGroup>

      <ListGroup title="Support">
        <ListItem icon="notifications-outline" tint="red" title="Notifications" badge={unread ?? undefined} onPress={() => router.push("/notifications")} />
        <ListItem icon="megaphone-outline" tint="orange" title="Complaints" subtitle="Raise a workplace concern" onPress={() => router.push("/complaints")} />
        <ListItem icon="bug-outline" tint="red" title="Report a Bug" subtitle="Something broken in the portal?" onPress={() => router.push("/bug-report")} />
        <ListItem icon="book-outline" tint="pink" title="SOP" subtitle="Standard Operating Procedure" onPress={() => router.push("/sop")} />
        <ListItem icon="business-outline" tint="gray" title="Company" subtitle="About Dashmani Media" onPress={() => router.push("/company")} />
        <ListItem icon="key-outline" tint="gray" title="Change Password" onPress={() => router.push("/change-password")} />
        {caps.canUseAdminPortal ? (
          <ListItem
            icon="swap-horizontal-outline"
            tint="indigo"
            title="Switch to Admin Portal"
            subtitle="For admins — team reports & approvals"
            onPress={toAdminPortal}
          />
        ) : null}
      </ListGroup>

      <ListGroup>
        <ListItem icon="log-out-outline" tint="red" title="Sign Out" destructive chevron={false} onPress={signOut} />
      </ListGroup>

      <Text maxFontSizeMultiplier={1.6} style={styles.version}>
        Dashmani Employee App · hr.digitalsukoon.com
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  version: { ...type.footnote, color: colors.tertiary, textAlign: "center", marginTop: spacing.sm },
});
