import React from "react";
import { Linking, StyleSheet, Text } from "react-native";
import { colors, spacing, type } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { Card, Screen } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { toast } from "@/components/feedback";

function openLink(url: string) {
  Linking.openURL(url).catch(() => {
    toast.show({ message: "Couldn't open the link. Try again.", tone: "danger" });
  });
}

export default function CompanyScreen() {
  const { caps } = useAuth();

  return (
    <Screen>
      <Card>
        <Text style={styles.name} maxFontSizeMultiplier={1.6} accessibilityRole="header">
          Dashmani Media Private Limited
        </Text>
        <Text style={styles.brand} maxFontSizeMultiplier={1.6}>
          Operating as Digital Sukoon — a full-service digital media & marketing agency.
        </Text>
      </Card>

      <ListGroup title="Our portals" style={styles.group}>
        <ListItem
          icon="briefcase-outline"
          tint="blue"
          title="Careers"
          subtitle="jobs.digitalsukoon.com"
          accessibilityHint="Opens in your browser"
          onPress={() => openLink("https://jobs.digitalsukoon.com")}
        />
        <ListItem
          icon="person-outline"
          tint="brand"
          title="Employee portal"
          subtitle="hr.digitalsukoon.com"
          accessibilityHint="Opens in your browser"
          onPress={() => openLink("https://hr.digitalsukoon.com")}
        />
        {caps.canUseAdminPortal ? (
          <ListItem
            icon="shield-checkmark-outline"
            tint="indigo"
            title="Admin portal"
            subtitle="portal.digitalsukoon.com"
            accessibilityHint="Opens in your browser"
            onPress={() => openLink("https://portal.digitalsukoon.com")}
          />
        ) : null}
      </ListGroup>

      <ListGroup title="Working week" style={styles.group}>
        <ListItem
          icon="calendar-outline"
          tint="green"
          title="Monday – Saturday"
          subtitle="Working days. Sunday is the weekly off."
          lines={2}
        />
        <ListItem
          icon="document-text-outline"
          tint="orange"
          title="Daily report"
          subtitle="Submit it every working day from the Daily Report tab."
          lines={2}
        />
      </ListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { ...type.headline, color: colors.ink },
  brand: { ...type.subhead, color: colors.sub, marginTop: spacing.xs + 2, lineHeight: 20 },
  group: { marginTop: spacing.sm },
});
