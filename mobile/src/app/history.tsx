import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, daysAgoIST, fmtRange, fmtTime, todayIST } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Chips, Screen, useApi } from "@/components/ui";
import { DateTile, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type HistoryLink = {
  id?: string;
  url?: string | null;
  accountName?: string | null;
  platform?: string | null;
  isScheduled?: boolean | null;
};

type HistoryReport = {
  id: string;
  /** YYYY-MM-DD (IST) */
  date: string;
  submittedAt?: string | null;
  notes?: string | null;
  links?: HistoryLink[] | null;
};

const WINDOWS = ["7D", "30D", "LATEST"] as const;
type Win = (typeof WINDOWS)[number];
const LABELS: Record<Win, string> = { "7D": "7 days", "30D": "30 days", LATEST: "Latest 30" };

function pathFor(win: Win): string {
  // The API returns at most the latest 30 reports; "Latest 30" asks for exactly that page.
  if (win === "LATEST") return "/hr/reports";
  const days = win === "7D" ? 7 : 30;
  return `/hr/reports?startDate=${daysAgoIST(days - 1)}&endDate=${todayIST()}`;
}

function postedLinks(r: HistoryReport): HistoryLink[] {
  return (r.links ?? []).filter((l) => !!l.url?.trim());
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function HistoryScreen() {
  const [win, setWin] = useState<Win>("30D");
  const [open, setOpen] = useState<string | null>(null);

  const state = useApi<HistoryReport[]>(
    async () => {
      const r = await apiFetch<HistoryReport[]>(pathFor(win));
      return Array.isArray(r) ? r : [];
    },
    [win],
    { keepData: true },
  );

  const reports = state.data ?? [];
  let summary: string | null = null;
  if (reports.length > 0) {
    // Computed from the returned page only — never presented as a window total.
    const dates = reports.map((r) => r.date).filter(Boolean).sort();
    const range = dates.length > 0 ? fmtRange(dates[0], dates[dates.length - 1]) : "";
    const links = reports.reduce((s, r) => s + postedLinks(r).length, 0);
    summary = `Latest ${plural(reports.length, "report")} · ${plural(links, "link")}${range ? ` (${range})` : ""}`;
  }

  const header = (
    <View>
      <Chips
        options={WINDOWS}
        value={win}
        onChange={(w) => {
          setOpen(null);
          setWin(w);
        }}
        labels={LABELS}
        accessibilityLabel="History window"
      />
      {summary ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.summary}>
          {summary}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList<HistoryReport>
        state={state}
        grouped
        header={header}
        keyExtractor={(r) => r.id}
        empty={{
          icon: "document-text-outline",
          title: win === "LATEST" ? "No reports yet" : "No reports in this window",
          text: "Reports you submit will show up here.",
        }}
        renderItem={(r) => {
          const links = postedLinks(r);
          const expanded = open === r.id;
          const platforms = Array.from(
            new Set(links.map((l) => (l.platform ?? "").trim()).filter((p) => p.length > 0)),
          ).join(", ");
          const time = r.submittedAt ? fmtTime(r.submittedAt) : "";
          const sub = [time && time !== "—" ? `Submitted ${time}` : "", platforms, r.notes?.trim() ?? ""]
            .filter(Boolean)
            .join(" · ");
          return (
            <React.Fragment>
              <ListItem
                leading={<DateTile date={r.date} tone="brand" />}
                title={plural(links.length, "link")}
                subtitle={sub || undefined}
                chevron={false}
                trailing={
                  <Ionicons
                    name={expanded ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={colors.faint}
                    style={styles.toggle}
                  />
                }
                accessibilityHint={expanded ? "Hides the links" : "Shows the links"}
                onPress={() => setOpen(expanded ? null : r.id)}
              />
              {expanded ? (
                <View style={styles.links}>
                  {links.length === 0 ? (
                    <Text maxFontSizeMultiplier={1.6} style={styles.linkMeta}>
                      No posted links in this report.
                    </Text>
                  ) : (
                    links.map((l, i) => (
                      <View key={l.id ?? `${r.id}:${i}`} style={styles.linkRow}>
                        <Text maxFontSizeMultiplier={1.3} style={styles.linkIdx}>
                          {i + 1}
                        </Text>
                        <View style={styles.linkBody}>
                          <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.linkUrl}>
                            {l.url}
                          </Text>
                          {l.accountName ? (
                            <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.linkMeta}>
                              {l.platform ? `${l.accountName} · ${l.platform}` : l.accountName}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    ))
                  )}
                  {r.notes ? (
                    <Text maxFontSizeMultiplier={1.6} style={styles.notes}>
                      Note: {r.notes}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </React.Fragment>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { ...type.footnote, color: colors.sub, marginBottom: spacing.sm, marginTop: spacing.xs },
  toggle: { marginLeft: spacing.sm },
  links: {
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  linkRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  linkIdx: { ...type.caption, ...type.numeric, width: 20, color: colors.tertiary, textAlign: "center", marginTop: 1 },
  linkBody: { flex: 1, minWidth: 0 },
  linkUrl: { ...type.subhead, color: colors.purpleText },
  linkMeta: { ...type.footnote, color: colors.sub, marginTop: 2 },
  notes: { ...type.footnote, color: colors.sub, marginTop: spacing.sm, fontStyle: "italic" },
});
