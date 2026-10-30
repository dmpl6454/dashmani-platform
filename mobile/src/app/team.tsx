import React from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Card, Empty, Screen, StatusPill, useApi } from "@/components/ui";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard, SkeletonList, SkeletonStatRow } from "@/components/skeleton";

type Member = {
  id: string;
  name?: string | null;
  email?: string | null;
  submittedToday?: boolean | null;
  weeklyReports?: number | null;
  totalLinks?: number | null;
};

type TeamData = {
  teamName?: string | null;
  memberCount?: number | null;
  members?: Member[] | null;
  submissionRate?: number | null;
};

function memberSubtitle(m: Member): string | undefined {
  const stats =
    m.weeklyReports != null
      ? `${m.weeklyReports} report${m.weeklyReports === 1 ? "" : "s"} this week · ${m.totalLinks ?? 0} links`
      : null;
  const text = [stats, m.email].filter((s): s is string => !!s).join("\n");
  return text || undefined;
}

export default function TeamScreen() {
  const state = useApi<TeamData>(() => apiFetch<TeamData>("/hr/team"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonCard lines={2} />
            <SkeletonStatRow count={2} />
            <SkeletonList rows={4} />
          </>
        }
        isEmpty={(d) => !d.teamName && (d.members ?? []).length === 0}
        empty={
          <Empty
            icon="people-outline"
            title="You're not in a team yet"
            text="When HR adds you to a team, you'll see who has submitted today and this week's reports here."
          />
        }
      >
        {(d) => {
          const members = d.members ?? [];
          const rate = d.submissionRate ?? 0;
          const submitted = members.filter((m) => m.submittedToday).length;
          return (
            <>
              <Card style={styles.hero}>
                <Text style={styles.teamName} accessibilityRole="header">
                  {d.teamName ?? "My Team"}
                </Text>
                <Text style={styles.teamSub}>Who's submitted today · this week's reports</Text>
              </Card>

              <StatGrid>
                <StatTile label="Members" value={members.length} icon="people-outline" />
                <StatTile
                  label="Submitted today"
                  value={`${rate}%`}
                  icon="checkmark-circle-outline"
                  tone="success"
                  progress={rate / 100}
                  hint={`${submitted} of ${members.length}`}
                />
              </StatGrid>

              {members.length > 0 ? (
                <ListGroup title="Members">
                  {members.map((m) => (
                    <ListItem
                      key={m.id}
                      leading={<Avatar name={m.name || "?"} size={36} />}
                      title={m.name || "Unnamed"}
                      subtitle={memberSubtitle(m)}
                      trailing={
                        m.submittedToday == null ? undefined : (
                          <StatusPill
                            size="sm"
                            status={m.submittedToday ? "DONE" : "PENDING"}
                            label={m.submittedToday ? "Submitted" : "Not yet"}
                          />
                        )
                      }
                    />
                  ))}
                </ListGroup>
              ) : null}
            </>
          );
        }}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center" },
  teamName: { ...type.title3, color: colors.ink, textAlign: "center" },
  teamSub: { ...type.footnote, color: colors.sub, marginTop: spacing.xs, textAlign: "center" },
});
