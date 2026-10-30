import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { colors, spacing, toneColors, type } from "@/lib/theme";
import { Button, Card, ErrorBanner, Screen, useApi } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { confirm, toast } from "@/components/feedback";
import { haptic } from "@/lib/device";

type SopSection = { title: string; items: string[] };
type SopStatus = { accepted: boolean; acceptedAt: string | null };
type SopData = { sections: SopSection[]; status: SopStatus };

const ACKNOWLEDGEMENT =
  "I have read and understood the Standard Operating Procedures and Terms of Employment of Dashmani Media Pvt. Ltd. (Digital Sukoon). I agree to abide by these policies during my employment.";

// Mirrors the HR web portal (apps/hr/src/app/sop/page.tsx): shown when HR has not published custom SOP content.
const DEFAULT_SECTIONS: SopSection[] = [
  {
    title: "Working Hours & Attendance",
    items: [
      "Standard working hours are 10:00 AM to 7:00 PM, Monday to Saturday.",
      "All employees must mark attendance daily through the HR portal.",
      "Late arrivals of more than 15 minutes will be recorded and may affect monthly reviews.",
      "Work from Home (WFH) must be requested and approved in advance through the portal.",
      "Compensatory offs (Comp-Off) must be approved by your reporting manager.",
    ],
  },
  {
    title: "Code of Conduct",
    items: [
      "Maintain professional behavior with colleagues, clients, and partners at all times.",
      "Respect confidentiality of client data, company strategies, and proprietary information.",
      "Do not share login credentials, client access, or internal tools with unauthorized persons.",
      "Personal use of company devices should be minimal and not interfere with work responsibilities.",
      "Harassment, discrimination, or bullying of any kind will not be tolerated and may result in immediate termination.",
    ],
  },
  {
    title: "Leave & Time-Off Policy",
    items: [
      "Employees are entitled to 12 paid leaves per year (1 per month).",
      "Sick leave requires notification before 10:00 AM on the day of absence.",
      "Leave applications must be submitted at least 3 days in advance for planned leaves.",
      "Unapproved absence for 3 consecutive days will be considered abandonment of duty.",
      "National holidays as declared by the company will be observed.",
    ],
  },
  {
    title: "Data & Social Media Policy",
    items: [
      "All social media accounts managed are property of the clients and the company.",
      "Never share client social media credentials outside of authorized tools.",
      "Content must be approved before publishing on any client account.",
      "Personal opinions must not be expressed through client or company accounts.",
      "Data breaches or unauthorized access must be reported immediately to your manager and admin.",
    ],
  },
  {
    title: "Termination & Exit Policy",
    items: [
      "A minimum notice period of 30 days is required for resignation.",
      "All company assets (laptops, phones, IDs) must be returned before the last working day.",
      "Exit interviews will be conducted by HR.",
      "Pending salary and dues will be cleared within 15 days of the last working day.",
      "Non-compete and NDA clauses in the employment contract remain valid after exit.",
    ],
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normalizeSection(raw: unknown, i: number): SopSection {
  const fallbackTitle = `Section ${i + 1}`;
  if (typeof raw === "string") return { title: fallbackTitle, items: [raw] };
  if (!isRecord(raw)) return { title: fallbackTitle, items: [] };
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : fallbackTitle;
  if (Array.isArray(raw.items)) {
    return { title, items: raw.items.filter((x): x is string => typeof x === "string" && x.trim().length > 0) };
  }
  if (typeof raw.content === "string") return { title, items: [raw.content] };
  if (typeof raw.body === "string") return { title, items: [raw.body] };
  return { title, items: [] };
}

function parseSections(content: unknown): SopSection[] {
  const raw = isRecord(content) && "sections" in content ? content.sections : content;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_SECTIONS;
  return raw.map(normalizeSection);
}

function parseStatus(status: unknown): SopStatus {
  if (!isRecord(status)) return { accepted: false, acceptedAt: null };
  return {
    accepted: status.accepted === true,
    acceptedAt: typeof status.acceptedAt === "string" ? status.acceptedAt : null,
  };
}

function SectionCard({ section }: { section: SopSection }) {
  return (
    <Card>
      <Text accessibilityRole="header" maxFontSizeMultiplier={1.4} style={styles.secTitle}>
        {section.title}
      </Text>
      {section.items.map((item, i) => (
        <View key={i} style={styles.bulletRow}>
          <Text maxFontSizeMultiplier={1.6} style={styles.bullet}>
            •
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.bulletText}>
            {item}
          </Text>
        </View>
      ))}
    </Card>
  );
}

export default function SopScreen() {
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const state = useApi<SopData>(async () => {
    const [content, status] = await Promise.all([
      apiFetch<unknown>("/hr/sop-content"),
      apiFetch<unknown>("/hr/sop-status"),
    ]);
    return { sections: parseSections(content), status: parseStatus(status) };
  });

  const accept = async () => {
    const ok = await confirm({
      title: "Accept the SOP?",
      message: ACKNOWLEDGEMENT,
      confirmLabel: "I Accept",
    });
    if (!ok) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      await apiFetch("/hr/accept-sop", { method: "POST" });
      toast.show({ message: "SOP accepted — thank you!", tone: "success" });
      void haptic("success");
      void state.reload();
    } catch (e) {
      setAcceptError(errorMessage(e, "Could not record your acceptance. Please try again."));
      void haptic("error");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock state={state}>
        {(d) => {
          const accepted = d.status.accepted;
          const tone = accepted ? "success" : "warning";
          const t = toneColors(tone);
          return (
            <>
              <Card variant="tinted" tone={tone}>
                <View style={styles.statusRow}>
                  <Ionicons
                    name={accepted ? "checkmark-circle" : "alert-circle"}
                    size={24}
                    color={t.fg}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                  <Text maxFontSizeMultiplier={1.6} style={[styles.statusText, { color: t.text }]}>
                    {accepted
                      ? d.status.acceptedAt
                        ? `Accepted on ${fmtDate(d.status.acceptedAt)}`
                        : "Accepted"
                      : "Please read and accept the Standard Operating Procedure"}
                  </Text>
                </View>
              </Card>

              {d.sections.map((s, i) => (
                <SectionCard key={`${i}:${s.title}`} section={s} />
              ))}

              {!accepted ? (
                <Card>
                  <Text maxFontSizeMultiplier={1.4} style={styles.secTitle}>
                    Acknowledgement required
                  </Text>
                  <Text maxFontSizeMultiplier={1.6} style={styles.ack}>
                    {ACKNOWLEDGEMENT}
                  </Text>
                  <ErrorBanner message={acceptError} />
                  <Button title="I have read & accept the SOP" onPress={accept} loading={accepting} />
                </Card>
              ) : null}
            </>
          );
        }}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  statusText: { ...type.subhead, fontWeight: "600", flex: 1 },
  secTitle: { ...type.headline, color: colors.ink, marginBottom: spacing.sm },
  bulletRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  bullet: { ...type.subhead, color: colors.sub, lineHeight: 21 },
  bulletText: { ...type.subhead, color: colors.sub, lineHeight: 21, flex: 1 },
  ack: { ...type.footnote, color: colors.sub, lineHeight: 19, marginBottom: spacing.md },
});
