import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, errorMessage, fmtDate, fmtDay, fmtMoney, isApiError } from "@/lib/api";
import { colors, spacing, toneColors, type } from "@/lib/theme";
import { Button, Card, Empty, ErrorBanner, Screen, useApi } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { ListGroup, ListItem } from "@/components/list";
import { confirm, toast } from "@/components/feedback";
import { haptic } from "@/lib/device";

type Contract = {
  id: string;
  contractDate: string | null;
  designation: string | null;
  department: string | null;
  salary: number | null;
  probationMonths: number | null;
  noticePeriod: number | null;
  agreedAt: string | null;
};

async function fetchContract(): Promise<Contract | null> {
  try {
    return await apiFetch<Contract | null>("/hr/contract");
  } catch (e) {
    // The API answers 404 CONTRACT_NOT_FOUND when no contract has been issued yet — that is an empty state, not a failure.
    if (isApiError(e) && (e.code === "CONTRACT_NOT_FOUND" || e.status === 404)) return null;
    throw e;
  }
}

function plural(n: number | null, unit: string): string {
  if (n === null || n === undefined) return "—";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function contractDay(value: string | null): string {
  if (!value) return "—";
  return fmtDay(value.slice(0, 10), { weekday: false, year: true });
}

export default function ContractScreen() {
  const [agreeing, setAgreeing] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);

  const state = useApi<Contract | null>(fetchContract);

  const agree = async (contract: Contract) => {
    const ok = await confirm({
      title: "Agree to contract?",
      message: "This records your digital acceptance of the employment contract.",
      confirmLabel: "I Agree",
    });
    if (!ok) return;
    setAgreeing(true);
    setAgreeError(null);
    try {
      await apiFetch(`/hr/contract/${contract.id}/agree`, { method: "POST" });
      toast.show({ message: "Contract accepted — a copy is available on the web portal", tone: "success" });
      void haptic("success");
      void state.reload();
    } catch (e) {
      setAgreeError(errorMessage(e, "Could not record your agreement. Please try again."));
      void haptic("error");
    } finally {
      setAgreeing(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock
        state={state}
        empty={
          <Card>
            <Empty
              icon="document-lock-outline"
              title="No contract yet"
              text="Your employment contract will appear here once HR issues it."
            />
          </Card>
        }
      >
        {(contract) => {
          if (!contract) return null;
          const signed = !!contract.agreedAt;
          const tone = signed ? "success" : "warning";
          const t = toneColors(tone);
          return (
            <>
              <Card variant="tinted" tone={tone}>
                <View style={styles.statusRow}>
                  <Ionicons
                    name={signed ? "checkmark-circle" : "alert-circle"}
                    size={24}
                    color={t.fg}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                  <Text maxFontSizeMultiplier={1.6} style={[styles.statusText, { color: t.text }]}>
                    {signed ? `Signed on ${fmtDate(contract.agreedAt)}` : "Awaiting your agreement"}
                  </Text>
                </View>
              </Card>

              <ListGroup title="Contract details">
                <ListItem title="Contract date" detail={contractDay(contract.contractDate)} />
                <ListItem title="Designation" detail={contract.designation ?? "—"} />
                <ListItem title="Department" detail={contract.department ?? "—"} />
                <ListItem title="Salary" detail={fmtMoney(contract.salary)} />
                <ListItem title="Probation" detail={plural(contract.probationMonths, "month")} />
                <ListItem title="Notice period" detail={plural(contract.noticePeriod, "day")} />
              </ListGroup>

              {!signed ? (
                <>
                  <ErrorBanner message={agreeError} />
                  <Button
                    title="I agree to this contract"
                    onPress={() => agree(contract)}
                    loading={agreeing}
                  />
                </>
              ) : null}
              <Text maxFontSizeMultiplier={1.6} style={styles.hint}>
                Read the full contract text on the web portal before agreeing.
              </Text>
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
  hint: { ...type.caption, color: colors.sub, textAlign: "center", marginTop: spacing.md },
});
