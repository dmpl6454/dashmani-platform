import React from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, fmtDate, fmtMoney } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { ListGroup, ListItem } from "@/components/list";

type OfferLetter = {
  id: string;
  letterType?: string | null;
  designation?: string | null;
  department?: string | null;
  salary?: number | string | null;
  joiningDate?: string | null;
  offerDate?: string | null;
};

function money(v: OfferLetter["salary"]): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? fmtMoney(n) : String(v);
}

export default function OfferLettersScreen() {
  const state = useApi<OfferLetter[]>(() => apiFetch<OfferLetter[]>("/hr/offer-letters"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        skeleton="cards"
        keyExtractor={(o) => o.id}
        empty={{
          icon: "mail-open-outline",
          title: "No letters yet",
          text: "Your offer and appointment letters appear here once HR issues them.",
        }}
        renderItem={(o) => (
          <ListGroup title={`${formatStatus(o.letterType ?? "OFFER")} letter`}>
            <ListItem title="Designation" detail={o.designation ?? "—"} />
            {o.department ? <ListItem title="Department" detail={o.department} /> : null}
            <ListItem title="Salary" detail={money(o.salary)} />
            <ListItem title="Joining date" detail={fmtDate(o.joiningDate)} />
            <ListItem title="Issued" detail={fmtDate(o.offerDate)} />
          </ListGroup>
        )}
        footer={
          <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
            Open the full letter on hr.digitalsukoon.com
          </Text>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
});
