import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, Platform } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { todayIST } from "@/lib/api";
import { colors, spacing, radius } from "@/lib/theme";
import { Card, Chips, Empty, ErrorBanner, Loading } from "@/components/ui";
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
  type Bootstrap,
  type BoardSnapshot,
  type Directory,
  type MineEntry,
  type SyncResponse,
} from "@/lib/pipeline";

// Pipeline board (hr.digitalsukoon.com/pipeline). A phone can't hold seven kanban columns, so
// the phases are a filter row over one list: "All" shows every phase as a section, a phase pill
// shows that phase alone. Polls POST /pipeline/sync at the server's board cadence while this
// screen is focused and the app is in the foreground.

const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;
type Scope = "all" | "mine";

export default function PipelineBoard() {
  const router = useRouter();
  const today = todayIST();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [board, setBoard] = useState<BoardSnapshot | null>(null);
  const [mine, setMine] = useState<MineEntry[]>([]);
  const [dir, setDir] = useState<Directory | null>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [phase, setPhase] = useState<string>("all");
  const [banner, setBanner] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [mustUpdate, setMustUpdate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [firstError, setFirstError] = useState<string | null>(null);
  const v = useRef(-1);
  const mineH = useRef<string | undefined>(undefined);

  useEffect(() => {
    getBootstrap(true)
      .then((b) => {
        setBoot(b);
        if (b && !b.enabled) setPaused(true);
      })
      .catch((e) => setFirstError(classify(e).message));
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
      setPaused(false);
      return (r.pollMs ?? DEFAULT_POLL_MS).board;
    } catch (e) {
      const c = classify(e);
      if (c.kind === "paused") setPaused(true);
      else setBanner(c.message);
      return c.retryAfterMs || DEFAULT_POLL_MS.board;
    }
  }, []);

  const enabled = !!boot && boot.enabled;
  usePolling(sync, enabled);

  const onRefresh = async () => {
    setRefreshing(true);
    v.current = -1; // ask for a fresh snapshot
    await sync();
    getDirectory(true).then(setDir).catch(() => undefined);
    setRefreshing(false);
  };

  const unreadOf = useMemo(() => new Map(mine.map((m) => [m.projectId, m.unread])), [mine]);
  const phases = useMemo(() => [...(board?.phases ?? (boot?.enabled ? boot.phases : []))].sort((a, b) => a.position - b.position), [board, boot]);
  const cards = useMemo(() => {
    const all = [...(board?.cards ?? [])].sort((a, b) => compareRank(a.rank, b.rank));
    return scope === "mine" ? all.filter((c) => unreadOf.has(c.id)) : all;
  }, [board, scope, unreadOf]);

  const sections = phases
    .filter((p) => phase === "all" || p.id === phase)
    .map((p) => ({ phase: p, cards: cards.filter((c) => c.phaseId === p.id), count: board?.perPhase?.[p.id] }));

  const header = (
    <Stack.Screen
      options={{
        title: "Pipeline",
        headerRight: () =>
          enabled && !paused ? (
            <Pressable onPress={() => router.push("/pipeline/new")} hitSlop={10} accessibilityLabel="New project">
              <Ionicons name="add" size={26} color={colors.purple} />
            </Pressable>
          ) : null,
      }}
    />
  );

  if (firstError && !board) {
    return (
      <View style={styles.fill}>
        {header}
        <View style={{ padding: spacing.lg }}>
          <ErrorBanner message={firstError} />
        </View>
      </View>
    );
  }
  if (!boot && !paused) {
    return (
      <View style={styles.fill}>
        {header}
        <Loading />
      </View>
    );
  }
  if (paused || (boot && !boot.enabled)) {
    return (
      <View style={styles.fill}>
        {header}
        <Empty icon="pause-circle-outline" text="Pipeline is paused. It will come back on its own." />
      </View>
    );
  }

  const phaseOptions = ["all", ...phases.map((p) => p.id)];
  const phaseLabels: Record<string, string> = { all: `All · ${cards.length}` };
  for (const p of phases) phaseLabels[p.id] = `${p.name} · ${cards.filter((c) => c.phaseId === p.id).length}`;

  return (
    <View style={styles.fill}>
      {header}
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.sub} />}
      >
        {mustUpdate ? <ErrorBanner message="A newer version of the app is needed for Pipeline. Update from TestFlight / the App Store." /> : null}
        {banner ? <Text style={styles.banner}>{banner}</Text> : null}

        <Chips options={["all", "mine"] as const} value={scope} onChange={setScope} labels={{ all: "All projects", mine: "My projects" }} />
        <Chips options={phaseOptions} value={phase} onChange={setPhase} labels={phaseLabels} />

        {!board ? (
          <Loading />
        ) : sections.every((s) => s.cards.length === 0) ? (
          <Empty icon="git-branch-outline" text={scope === "mine" ? "You're not on any project yet." : "No projects here yet."} />
        ) : (
          sections.map((s) =>
            s.cards.length === 0 && phase === "all" ? null : (
              <View key={s.phase.id} style={{ marginBottom: spacing.lg }}>
                <View style={styles.sectionHead}>
                  <View style={[styles.dot, { backgroundColor: phaseColor(s.phase.color) }]} />
                  <Text style={styles.sectionTitle}>{s.phase.name.toUpperCase()}</Text>
                  <Text style={styles.sectionCount}>
                    {s.count?.truncated ? `${s.count.shown} of ${s.count.total}` : s.cards.length}
                  </Text>
                </View>
                <Card style={{ padding: 0 }}>
                  {s.cards.length === 0 ? (
                    <Text style={styles.none}>No projects in this stage.</Text>
                  ) : (
                    s.cards.map((c, i) => {
                      const due = dueState(c.dueDate, s.phase.isTerminal, today);
                      const dc = dueColors(due);
                      const unread = unreadOf.get(c.id) ?? 0;
                      return (
                        <Pressable
                          key={c.id}
                          onPress={() => router.push(`/pipeline/${c.id}`)}
                          style={({ pressed }) => [styles.card, i > 0 && styles.cardDivider, pressed && { opacity: 0.7 }]}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.title, unread > 0 && { fontWeight: "700" }]} numberOfLines={2}>
                              {c.title}
                            </Text>
                            <View style={styles.meta}>
                              {c.dueDate ? (
                                <View style={[styles.due, continuous, { backgroundColor: dc.bg }]}>
                                  <Text style={[styles.dueText, { color: dc.fg }]}>
                                    {due === "overdue" ? "Overdue · " : due === "today" ? "Due today · " : "Due "}
                                    {dayLabel(c.dueDate, today)}
                                  </Text>
                                </View>
                              ) : null}
                              <AvatarStack ids={c.preview} byId={dir?.byId} extra={Math.max(0, c.memberCount - c.preview.length)} />
                            </View>
                          </View>
                          {unread > 0 ? (
                            <View style={styles.badge}>
                              <Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text>
                            </View>
                          ) : null}
                          <Ionicons name="chevron-forward" size={15} color={colors.faint} />
                        </Pressable>
                      );
                    })
                  )}
                </Card>
              </View>
            ),
          )
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  banner: { fontSize: 12.5, color: colors.sub, marginBottom: spacing.md },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, paddingHorizontal: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  sectionTitle: { fontSize: 13, color: colors.sub, fontWeight: "500", flex: 1 },
  sectionCount: { fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] },
  none: { fontSize: 13, color: colors.faint, padding: spacing.lg },
  card: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: spacing.lg },
  cardDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  title: { fontSize: 15.5, color: colors.ink, fontWeight: "500" },
  meta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" },
  due: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.sm },
  dueText: { fontSize: 11.5, fontWeight: "600" },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.purple, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
});
