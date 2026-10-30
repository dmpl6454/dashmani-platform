import React from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, fmtDateTime } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { ListItem } from "@/components/list";

type Presentation = {
  id: string;
  title: string;
  theme?: string | null;
  updatedAt: string;
};

export default function PresentationsScreen() {
  const state = useApi<Presentation[]>(() => apiFetch<Presentation[]>("/hr/presentations"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(p) => p.id}
        empty={{
          icon: "easel-outline",
          title: "No presentations yet",
          text: "Presentations you create on hr.digitalsukoon.com/presentations show up here.",
        }}
        renderItem={(p) => (
          <ListItem
            icon="easel-outline"
            tint="orange"
            title={p.title || "Untitled presentation"}
            subtitle={`${p.theme ?? "default"} theme · updated ${fmtDateTime(p.updatedAt)}`}
          />
        )}
      />
      <Text style={styles.hint} maxFontSizeMultiplier={1.6}>
        The app shows your presentations only. Create and edit them (including AI generation) on
        hr.digitalsukoon.com/presentations — the editor needs a big screen.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm, lineHeight: 18 },
});
