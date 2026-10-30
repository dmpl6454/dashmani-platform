import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { Stack, useRouter } from "expo-router";
import { errorStatus, isNetworkError, todayIST } from "@/lib/api";
import { colors, radius, spacing, type } from "@/lib/theme";
import { Chips, Empty, ErrorBanner, LoadFailed, Screen, useApi } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { HeaderButton, ListGroup, ListItem } from "@/components/list";
import { SkeletonList } from "@/components/skeleton";
import { AvatarStack, usePolling } from "@/components/pipeline";
import {
  PIPELINE_CLIENT_BUILD,
  DEFAULT_POLL_MS,
  classify,
  compareRank,
  dayLabel,
  dueColors,
  dueState,
  getBootstrap,
  getDirectory,
  phaseColor,
  pipe,
  type BoardSnapshot,
  type Directory,
  type MineEntry,
  type SyncResponse,
} from "@/lib/pipeline";

// Pipeline board (hr.digitalsukoon.com/pipeline). A phone can't hold seven kanban columns, so
// the phases are a filter row over one list: "All" shows every phase as a section, a phase pill
// shows that phase alone. Polls POST /pipeline/sync at the server's board cadence while this
// screen is focused and the app is in the foreground.

const continuous: ViewStyle | null = Platform.OS === "ios" ? { borderCurve: "continuous" } : null;
type Scope = "all" | "mine";
type SyncFailure = { message: string; code: string | null; status: number | null };

export default function PipelineBoard() {
  const router = useRouter();
  const today = todayIST();
  const boot = useApi(() => getBootstrap(true), []);
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [mine, setMine] = useState<MineEntry[]>([]);
  const [dir, setDir] = useState<Directory | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [phase, setPhase] = useState<string>("all");
  const [banner, setBanner] = useState<string | null>(null);
  const [syncPaused, setSyncPaused] = useState(false);
  const [syncFailure, setSyncFailure] = useState<SyncFailure | null>(null);
  const [mustUpdate, setMustUpdate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const v = useRef(-1);
  const mineH = useRef<string | undefined>(undefined);

  useEffect(() => {
    getDirectory().then(setDir).catch(() => undefined);
  }, []);

  const sync = useCallback(async (): Promise<number> => {
    try {
      const r = await pipe<SyncResponse>("/sync", {
        method: "POST",
        body: JSON.stringify({ clientBuild: PIPELINE_CLIENT_BUILD, board: { v: v.current }, ...(mineH.current ? { mineH: mineH.current } : {}) }),
      });
      if (r.board) {
        setBoard(r.board);
        v.current = r.board.v;
      }
      if (r.mine) {
        setMine(r.mine);
        mineH.current = r.mineH;
      }
      setMustUpdate(r.reload);
      setBanner(r.boardUnavailable ? "The board is catching up — showing the last update." : null);
      setSyncPaused(false);
      setSyncFailure(null);
      return (r.pollMs ?? DEFAULT_POLL_MS).board;
    } catch (e) {
      const c = classify(e);
      if (c.kind === "paused") {
        setSyncPaused(true);
      } else {
        setBanner(c.message);
        setSyncFailure({ message: c.message, code: isNetworkError(e) ? "NETWORK_ERROR" : null, status: errorStatus(e) });
      }
      return c.retryAfterMs || DEFAULT_POLL_MS.board;
    }
  }, []);

  const enabled = !!boot.data && boot.data.enabled;
  const paused = syncPaused || (!!boot.data && !boot.data.enabled);
  usePolling(sync, enabled);

  const onRefresh = async () => {
    setRefreshing(true);
    if (!boot.data) {
      await boot.reload();
    } else {
      v.current = -1; // ask for a fresh snapshot
      await sync();
      getDirectory(true).then(setDir).catch(() => undefined);
    }
    setRefreshing(false);
  };

  const unreadOf = useMemo(() => new Map(mine.map((m) => [m.projectId, m.unread])), [mine]);
  const phases = useMemo(() => {
    const fromBoot = boot.data && boot.data.enabled ? boot.data.phases : [];
    return [...(board?.phases ?? fromBoot)].sort((a, b) => a.position - b.position);
  }, [board, boot.data]);
  const cards = useMemo(() => {
    const all = [...(board?.cards ?? [])].sort((a, b) => compareRank(a.rank, b.rank));
    return scope === "mine" ? all.filter((c) => unreadOf.has(c.id)) : all;
  }, [board, scope, unreadOf]);

  const sections = phases
    .filter((p) => phase === "all" || p.id === phase)
    .map((p) => ({ phase: p, cards: cards.filter((c) => c.phaseId === p.id), count: board?.perPhase?.[p.id] }));

  const phaseOptions = ["all", ...phases.map((p) => p.id)];
  const phaseLabels: Record<string, string> = { all: "All" };
  const phaseCounts: Record<string, number> = { all: cards.length };
  for (const p of phases) {
    phaseLabels[p.id] = p.name;
    phaseCounts[p.id] = cards.filter((c) => c.phaseId === p.id).length;
  }

  let list: React.ReactNode;
  if (!board) {
    list = syncFailure ? (
      <LoadFailed
        error={syncFailure.message}
        code={syncFailure.code}
        status={syncFailure.status}
        onRetry={() => {
          void onRefresh();
        }}
      />
    ) : (
      <SkeletonList rows={6} />
    );
  } else if (sections.every((s) => s.cards.length === 0)) {
    list =
      phase !== "all" ? (
        <Empty
          icon="git-branch-outline"
          title="No projects in this stage"
          text="Nothing is in this stage right now."
          action={{ label: "Show all stages", onPress: () => setPhase("all") }}
        />
      ) : (
        <Empty
          icon="git-branch-outline"
          title={scope === "mine" ? "No projects of yours" : "No projects yet"}
          text={scope === "mine" ? "You're not on any project yet." : "No projects here yet."}
        />
      );
  } else {
    list = sections
      .filter((s) => s.cards.length > 0)
      .map((s) => {
        const countText = s.count?.truncated ? `${s.count.shown} of ${s.count.total}` : String(s.cards.length);
        return (
          <ListGroup key={s.phase.id} title={`${s.phase.name} · ${countText}`}>
            {s.cards.map((c) => {
              const due = dueState(c.dueDate, s.phase.isTerminal, today);
              const dc = dueColors(due);
              const unread = unreadOf.get(c.id) ?? 0;
              const dueText = c.dueDate ? `Due ${dayLabel(c.dueDate, today)}` : undefined;
              const flag = due === "overdue" ? "Overdue" : due === "today" ? "Today" : null;
              return (
                <ListItem
                  key={c.id}
                  title={c.title}
                  subtitle={dueText}
                  lines={2}
                  leading={
                    <View style={styles.dotWrap}>
                      <View style={[styles.dot, { backgroundColor: phaseColor(s.phase.color) }]} />
                    </View>
                  }
                  trailing={
                    <View style={styles.trailing}>
                      {flag ? (
                        <View style={[styles.flag, continuous, { backgroundColor: dc.bg }]}>
                          <Text maxFontSizeMultiplier={1.3} style={[styles.flagText, { color: dc.fg }]}>
                            {flag}
                          </Text>
                        </View>
                      ) : null}
                      <AvatarStack ids={c.preview} byId={dir?.byId} extra={Math.max(0, c.memberCount - c.preview.length)} />
                    </View>
                  }
                  badge={unread > 0 ? unread : undefined}
                  onPress={() => router.push(`/pipeline/${c.id}`)}
                  accessibilityLabel={[
                    c.title,
                    flag === "Overdue" ? "overdue" : flag === "Today" ? "due today" : undefined,
                    dueText,
                    unread > 0 ? `${unread} unread` : undefined,
                  ]
                    .filter((x): x is string => !!x)
                    .join(", ")}
                />
              );
            })}
          </ListGroup>
        );
      });
  }

  return (
    <Screen onRefresh={onRefresh} refreshing={refreshing}>
      <Stack.Screen
        options={{
          title: "Pipeline",
          headerRight: () =>
            enabled && !paused ? (
              <HeaderButton icon="add" label="New project" onPress={() => router.push("/pipeline/new")} />
            ) : null,
        }}
      />
      <AsyncBlock
        state={boot}
        skeleton={<SkeletonList rows={6} />}
        empty={
          <Empty
            icon="lock-closed-outline"
            title="Pipeline needs the employee portal"
            text="Sign in to the employee portal to see the board."
          />
        }
      >
        {() =>
          paused ? (
            <Empty icon="pause-circle-outline" title="Pipeline is paused" text="It will come back on its own." />
          ) : (
            <>
              {mustUpdate ? (
                <ErrorBanner message="A newer version of the app is needed for Pipeline. Update from TestFlight / the App Store." />
              ) : null}
              {banner && board ? <Text style={styles.banner}>{banner}</Text> : null}

              <Chips
                options={["all", "mine"] as const}
                value={scope}
                onChange={setScope}
                labels={{ all: "All projects", mine: "My projects" }}
                accessibilityLabel="Projects to show"
              />
              <Chips
                options={phaseOptions}
                value={phase}
                onChange={setPhase}
                labels={phaseLabels}
                counts={phaseCounts}
                mode="pills"
                accessibilityLabel="Stage"
              />

              {list}
            </>
          )
        }
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: { ...type.footnote, color: colors.sub, marginBottom: spacing.md },
  dotWrap: { width: 12, alignItems: "center", justifyContent: "center" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  trailing: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: spacing.xs },
  flag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm },
  flagText: { ...type.caption2, fontWeight: "600" },
});
