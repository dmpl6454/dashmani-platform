import React, { useState } from "react";
import { Platform, Share, StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtMoney, MONTHS } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Button, Card, Screen, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";

type SalarySlip = {
  id: string;
  month: number;
  year: number;
  basicSalary: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  otherEarnings: number;
  pf: number;
  esi: number;
  tax: number;
  otherDeductions: number;
  netSalary: number;
  status: string;
  remarks?: string | null;
};

type Line = { label: string; value: number };

function periodOf(s: SalarySlip): string {
  const name = MONTHS[(s.month ?? 1) - 1] ?? "";
  return `${name} ${s.year}`.trim();
}

function earningsOf(s: SalarySlip): Line[] {
  return [
    { label: "Basic salary", value: s.basicSalary },
    { label: "HRA", value: s.hra },
    { label: "Conveyance", value: s.conveyance },
    { label: "Medical allowance", value: s.medicalAllowance },
    { label: "Special allowance", value: s.specialAllowance },
    { label: "Other earnings", value: s.otherEarnings },
  ];
}

function deductionsOf(s: SalarySlip): Line[] {
  return [
    { label: "PF", value: s.pf },
    { label: "ESI", value: s.esi },
    { label: "Tax", value: s.tax },
    { label: "Other deductions", value: s.otherDeductions },
  ];
}

function total(lines: Line[]): number {
  return lines.reduce((acc, l) => acc + (Number(l.value) || 0), 0);
}

function isProvisional(status: string): boolean {
  return status === "PENDING_APPROVAL" || status === "DRAFT";
}

function summaryOf(s: SalarySlip): string {
  const earnings = earningsOf(s);
  const deductions = deductionsOf(s);
  return [
    `Salary slip — ${periodOf(s)}`,
    `Gross earnings: ${fmtMoney(total(earnings))}`,
    `Deductions: ${fmtMoney(total(deductions))}`,
    `Net salary: ${fmtMoney(s.netSalary)}`,
    isProvisional(s.status) ? "Status: awaiting approval" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function SlipDetail({ slip }: { slip: SalarySlip }) {
  const earnings = earningsOf(slip);
  const deductions = deductionsOf(slip);
  return (
    <View>
      <Card variant="tinted" tone="success">
        <View style={styles.netRow}>
          <View style={styles.flex}>
            <Text style={styles.netLabel} maxFontSizeMultiplier={1.6}>
              Net salary
            </Text>
            <Text style={styles.netValue} maxFontSizeMultiplier={1.3}>
              {fmtMoney(slip.netSalary)}
            </Text>
          </View>
          <StatusPill status={slip.status} size="sm" />
        </View>
        {isProvisional(slip.status) ? (
          <Text style={styles.provisional} maxFontSizeMultiplier={1.6}>
            This slip is awaiting approval — the figures may still change.
          </Text>
        ) : null}
      </Card>

      <ListGroup title="Earnings" footer={`Gross ${fmtMoney(total(earnings))}`}>
        {earnings.map((l) => (
          <ListItem key={l.label} title={l.label} detail={fmtMoney(l.value)} />
        ))}
      </ListGroup>

      <ListGroup title="Deductions" footer={`Total ${fmtMoney(total(deductions))}`}>
        {deductions.map((l) => (
          <ListItem key={l.label} title={l.label} detail={`−${fmtMoney(l.value)}`} />
        ))}
      </ListGroup>

      {slip.remarks ? (
        <Text style={styles.remarks} maxFontSizeMultiplier={1.6}>
          Note: {slip.remarks}
        </Text>
      ) : null}
    </View>
  );
}

export default function SalarySlipsScreen() {
  const state = useApi<SalarySlip[]>(() => apiFetch<SalarySlip[]>("/hr/salary-slips"));
  const [selected, setSelected] = useState<SalarySlip | null>(null);
  const [open, setOpen] = useState(false);

  const show = (s: SalarySlip) => {
    setSelected(s);
    setOpen(true);
  };

  const share = async (s: SalarySlip) => {
    try {
      await Share.share({ message: summaryOf(s) });
    } catch {
      toast.show({ message: "Couldn't open the share sheet", tone: "danger" });
    }
  };

  const canShare = Platform.OS !== "web";

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        skeleton="rows"
        keyExtractor={(s) => s.id}
        empty={{
          icon: "cash-outline",
          title: "No salary slips yet",
          text: "Your monthly slips appear here once HR generates them.",
        }}
        renderItem={(s) => (
          <ListItem
            title={periodOf(s)}
            subtitle={`${fmtMoney(s.netSalary)} net`}
            icon="cash-outline"
            tint="green"
            trailing={<StatusPill status={s.status} size="sm" />}
            onPress={() => show(s)}
            accessibilityHint="Opens the salary breakdown"
          />
        )}
      />

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title={selected ? periodOf(selected) : undefined}
        subtitle="Salary slip"
        detent="large"
        footer={
          selected && canShare ? (
            <Button title="Share summary" variant="plain" icon="share-outline" onPress={() => share(selected)} />
          ) : undefined
        }
      >
        {selected ? <SlipDetail slip={selected} /> : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  netRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  netLabel: { ...type.subhead, color: colors.sub },
  netValue: { ...type.title1, ...type.numeric, color: colors.ink, marginTop: 2 },
  provisional: { ...type.footnote, color: colors.warningText, marginTop: spacing.sm },
  remarks: { ...type.subhead, color: colors.sub, marginTop: spacing.sm },
});
