import React from "react";
import { Text, StyleSheet, Linking, Pressable } from "react-native";
import { colors } from "@/lib/theme";
import { Screen, Card, SectionTitle, Row } from "@/components/ui";

export default function CompanyScreen() {
  return (
    <Screen>
      <Card>
        <Text style={styles.name}>Dashmani Media Private Limited</Text>
        <Text style={styles.brand}>Operating as Digital Sukoon — a full-service digital media & marketing agency.</Text>
      </Card>
      <SectionTitle>Our Portals</SectionTitle>
      <Card>
        <Row icon="briefcase-outline" title="Careers" subtitle="jobs.digitalsukoon.com" onPress={() => Linking.openURL("https://jobs.digitalsukoon.com")} />
        <Row icon="person-outline" title="Employee Portal" subtitle="hr.digitalsukoon.com" onPress={() => Linking.openURL("https://hr.digitalsukoon.com")} />
        <Row icon="shield-checkmark-outline" title="Admin Portal" subtitle="portal.digitalsukoon.com" onPress={() => Linking.openURL("https://portal.digitalsukoon.com")} />
      </Card>
      <SectionTitle>Working Week</SectionTitle>
      <Card>
        <Text style={styles.body}>Monday – Saturday are working days. Sunday is the weekly off.</Text>
        <Text style={styles.body}>Daily report submission is expected every working day via the Daily Report tab.</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 17, fontWeight: "800", color: colors.ink },
  brand: { fontSize: 13, color: colors.sub, marginTop: 6, lineHeight: 19 },
  body: { fontSize: 13, color: colors.sub, lineHeight: 20, marginBottom: 6 },
});
