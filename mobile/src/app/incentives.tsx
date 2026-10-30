import React from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, fmtDate, fmtMoney, MONTHS } from "@/lib/api";
import { colors, type } from "@/lib/theme";
import { Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { ListItem, StatGrid, StatTile } from "@/components/list";

type Incentive = {
  id: string;
  amount: number;
  reason: string;
  month: number | null;
  year: number | null;
  createdAt: string;
};

function periodOf(i: Incentive): string {
  if (i.month && i.year) {
    const month = MONTHS[i.month - 1];
    return month ? `${month} ${i.year}` : String(i.year);
  }
  return fmtDate(i.createdAt);
}

export default function IncentivesScreen() {
  const state = useApi<Incentive[]>(() => apiFetch<Incentive[]>("/hr/incentives"));

  const items = state.data ?? [];
  const total = items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        skeleton="stats"
        keyExtractor={(i) => i.id}
        header={
          items.length > 0 ? (
            <StatGrid>
              <StatTile
                key="total"
                label="Total earned"
                value={fmtMoney(total)}
                icon="gift-outline"
                tone="success"
                valueColor={colors.greenText}
              />
              <StatTile key="count" label="Awards" value={items.length} icon="ribbon-outline" tone="brand" />
            </StatGrid>
          ) : null
        }
        renderItem={(i) => (
          <ListItem
            title={i.reason}
            subtitle={periodOf(i)}
            icon="gift-outline"
            tint="green"
            lines={2}
            accessibilityLabel={`${i.reason}, ${periodOf(i)}, ${fmtMoney(i.amount)}`}
            trailing={
              <Text maxFontSizeMultiplier={1.4} style={styles.amount}>
                {fmtMoney(i.amount)}
              </Text>
            }
          />
        )}
        empty={{
          icon: "gift-outline",
          title: "No incentives yet",
          text: "Incentives HR awards you will appear here.",
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  amount: { ...type.subhead, ...type.numeric, fontWeight: "700", color: colors.greenText },
});
