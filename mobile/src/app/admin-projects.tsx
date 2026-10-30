import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetchPage, fmtDate } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { Screen, StatusPill } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { Sheet } from "@/components/sheet";

type Project = {
  id: string;
  name: string;
  status?: string | null;
  description?: string | null;
  startDate?: string | null;
  client?: { companyName?: string | null } | null;
  _count?: { tasks?: number; accounts?: number };
  tasks?: unknown[];
  accounts?: unknown[];
};

function taskCount(p: Project): number {
  return p._count?.tasks ?? p.tasks?.length ?? 0;
}

function accountCount(p: Project): number {
  return p._count?.accounts ?? p.accounts?.length ?? 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function subtitleOf(p: Project): string {
  const head = [p.client?.companyName ?? "", p.startDate ? `since ${fmtDate(p.startDate)}` : ""]
    .filter(Boolean)
    .join(" · ");
  const counts = `${plural(taskCount(p), "task")} · ${plural(accountCount(p), "account")}`;
  return head ? `${head}\n${counts}` : counts;
}

export default function AdminProjects() {
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<Project | null>(null);
  const state = useApi<Project[]>(async () => {
    const page = await apiFetchPage<Project>("/projects?limit=500");
    setHasMore(page.meta.has_more);
    return page.items;
  });

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(p) => p.id}
        empty={{ icon: "folder-outline", title: "No projects", text: "Projects created on the web portal show up here." }}
        footer={
          hasMore ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.note}>
              Showing the first 500 projects. See the full list on the web portal.
            </Text>
          ) : null
        }
        renderItem={(p) => (
          <ListItem
            icon="folder-outline"
            tint="blue"
            title={p.name}
            subtitle={subtitleOf(p)}
            trailing={p.status ? <StatusPill size="sm" status={p.status} /> : undefined}
            onPress={() => setSelected(p)}
          />
        )}
      />

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        subtitle={selected?.status ? formatStatus(selected.status) : undefined}
      >
        {selected?.description ? (
          <Text maxFontSizeMultiplier={1.6} style={styles.desc}>
            {selected.description}
          </Text>
        ) : null}
        {selected ? (
          <ListGroup>
            <ListItem icon="business-outline" tint="blue" title="Client" detail={selected.client?.companyName || "—"} />
            <ListItem
              icon="calendar-outline"
              tint="orange"
              title="Started"
              detail={selected.startDate ? fmtDate(selected.startDate) : "—"}
            />
            <ListItem icon="checkbox-outline" tint="green" title="Tasks" detail={String(taskCount(selected))} />
            <ListItem icon="at-outline" tint="indigo" title="Accounts" detail={String(accountCount(selected))} />
          </ListGroup>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
  desc: { ...type.subhead, color: colors.sub, marginBottom: spacing.lg },
});
