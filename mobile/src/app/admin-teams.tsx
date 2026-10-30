import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { apiFetchPage } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { Avatar, Card, Empty, Screen } from "@/components/ui";
import { ListGroup, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { Sheet } from "@/components/sheet";

type Member = {
  id: string;
  name?: string | null;
  email?: string | null;
  profileImageUrl?: string | null;
};

type Team = {
  id: string;
  name: string;
  description?: string | null;
  members?: Member[];
  _count?: { members?: number };
  children?: Team[];
};

function memberCount(t: Team): number {
  return t._count?.members ?? t.members?.length ?? 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function teamSubtitle(t: Team): string | undefined {
  if (t.description) return t.description;
  const names = (t.members ?? []).map((m) => m.name ?? "").filter(Boolean);
  return names.length > 0 ? names.join(" · ") : undefined;
}

export default function AdminTeams() {
  const router = useRouter();
  const state = useApi<Team[]>(async () => (await apiFetchPage<Team>("/teams?limit=500")).items);
  const [selected, setSelected] = useState<Team | null>(null);

  const openMember = (m: Member) => {
    setSelected(null);
    router.push(`/admin-employee/${m.id}?name=${encodeURIComponent(m.name ?? "")}`);
  };

  const members = selected?.members ?? [];
  const subTeams = selected?.children ?? [];

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(t) => t.id}
        empty={{ icon: "git-branch-outline", title: "No teams yet", text: "Teams created on the web portal show up here." }}
        renderItem={(t) => (
          <ListItem
            icon="git-branch-outline"
            tint="indigo"
            title={t.name}
            subtitle={teamSubtitle(t)}
            detail={plural(memberCount(t), "member")}
            onPress={() => setSelected(t)}
          />
        )}
      />

      <Sheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        subtitle={selected ? plural(memberCount(selected), "member") : undefined}
      >
        {selected?.description ? (
          <Text maxFontSizeMultiplier={1.6} style={styles.desc}>
            {selected.description}
          </Text>
        ) : null}

        {subTeams.length > 0 ? (
          <ListGroup title="Sub-teams">
            {subTeams.map((c) => (
              <ListItem
                key={c.id}
                icon="git-branch-outline"
                tint="indigo"
                title={c.name}
                detail={plural(memberCount(c), "member")}
                onPress={() => setSelected(c)}
              />
            ))}
          </ListGroup>
        ) : null}

        {members.length > 0 ? (
          <ListGroup title="Members">
            {members.map((m) => (
              <ListItem
                key={m.id}
                leading={<Avatar name={m.name ?? "?"} uri={m.profileImageUrl} size={32} />}
                title={m.name ?? "Unnamed"}
                subtitle={m.email ?? undefined}
                onPress={() => openMember(m)}
                accessibilityHint="Opens this employee's reports"
              />
            ))}
          </ListGroup>
        ) : (
          <Card>
            <Empty compact icon="people-outline" text="No members in this team yet" />
          </Card>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  desc: { ...type.subhead, color: colors.sub, marginBottom: spacing.lg },
});
