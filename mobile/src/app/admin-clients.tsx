import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetchPage } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { Avatar, Screen, StatusPill } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type Client = {
  id: string;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  status?: string | null;
  _count?: { projects?: number };
  projects?: unknown[];
};

function projectCount(c: Client): number {
  return c._count?.projects ?? c.projects?.length ?? 0;
}

function subtitleOf(c: Client): string {
  const contact = [c.contactName, c.email].filter((s): s is string => !!s).join(" · ");
  const n = projectCount(c);
  const projects = `${n} project${n === 1 ? "" : "s"}`;
  return contact ? `${contact}\n${projects}` : projects;
}

export default function AdminClients() {
  const [hasMore, setHasMore] = useState(false);
  const state = useApi<Client[]>(async () => {
    const page = await apiFetchPage<Client>("/clients?limit=500");
    setHasMore(page.meta.has_more);
    return page.items;
  });

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(c) => c.id}
        empty={{ icon: "business-outline", title: "No clients", text: "Clients added on the web portal show up here." }}
        footer={
          hasMore ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.note}>
              Showing the first 500 clients. Search the full list on the web portal.
            </Text>
          ) : null
        }
        renderItem={(c) => (
          <ListItem
            leading={<Avatar name={c.companyName || "?"} size={32} />}
            title={c.companyName || "Unnamed client"}
            subtitle={subtitleOf(c)}
            trailing={<StatusPill size="sm" status={c.status ?? "ACTIVE"} />}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
});
