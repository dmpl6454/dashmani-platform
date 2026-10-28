import React, { useCallback, useRef, useState } from "react";
import { AppState, Text, View, StyleSheet, Platform } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Row } from "@/components/ui";
import { colors } from "@/lib/theme";
import { getBootstrap, type Bootstrap, type DirectoryEntry } from "@/lib/pipeline";

const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;

/**
 * Runs `tick` repeatedly while the screen is focused AND the app is in the foreground —
 * never while backgrounded (iOS would suspend it anyway; this keeps it from bursting on
 * resume). `tick` returns the delay before the next run in ms. One run at a time.
 */
export function usePolling(tick: () => Promise<number>, enabled = true) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const active = useRef(false);

  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    if (!active.current) return;
    timer.current = setTimeout(async () => {
      if (!active.current || running.current) return;
      running.current = true;
      let next = 15_000;
      try {
        next = await tickRef.current();
      } finally {
        running.current = false;
      }
      schedule(next);
    }, ms);
  }, []);

  const start = useCallback(() => {
    if (active.current) return;
    active.current = true;
    schedule(0);
  }, [schedule]);

  const stop = useCallback(() => {
    active.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      if (AppState.currentState === "active") start();
      const sub = AppState.addEventListener("change", (s) => (s === "active" ? start() : stop()));
      return () => {
        sub.remove();
        stop();
      };
    }, [enabled, start, stop]),
  );

  /** Run now (e.g. after a send), then continue at the returned cadence. */
  return useCallback(() => {
    if (!active.current) return;
    schedule(0);
  }, [schedule]);
}

/** Up to 3 member initials, overlapped, like the web's avatar stack. */
export function AvatarStack({ ids, byId, extra = 0 }: { ids: string[]; byId: Map<string, DirectoryEntry> | undefined; extra?: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      {ids.slice(0, 3).map((id, i) => (
        <View key={id} style={[styles.avatar, continuous, i > 0 && { marginLeft: -6 }]}>
          <Text style={styles.avatarText}>{byId?.get(id)?.initials ?? "·"}</Text>
        </View>
      ))}
      {extra > 0 ? <Text style={styles.more}>+{extra}</Text> : null}
    </View>
  );
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  return (
    <View style={[styles.avatar, continuous, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.36 }]}>{initials}</Text>
    </View>
  );
}

/**
 * The "Pipeline" row for a More tab. Shown only when the HR session's bootstrap says the
 * board is on for this person (navVisible); a schema pause shows a quiet disabled row; the
 * feature switched off (or no HR session, from the admin portal) shows nothing.
 */
export function PipelineEntryRow() {
  const router = useRouter();
  const [boot, setBoot] = useState<Bootstrap | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getBootstrap()
        .then((b) => alive && setBoot(b))
        .catch(() => alive && setBoot(null));
      return () => {
        alive = false;
      };
    }, []),
  );

  if (!boot) return null;
  if (boot.enabled && boot.navVisible) {
    return (
      <Row
        icon="git-branch-outline"
        iconColor="#F0568C"
        title="Pipeline"
        subtitle="Projects, stages & team conversation"
        onPress={() => router.push("/pipeline")}
      />
    );
  }
  if (!boot.enabled && boot.reason === "paused") {
    return <Row icon="git-branch-outline" iconColor="#8E8E93" title="Pipeline" subtitle="Paused — it will come back on its own" />;
  }
  return null;
}

const styles = StyleSheet.create({
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.pinkSoft,
    borderWidth: 1.5,
    borderColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 9.5, fontWeight: "700", color: colors.pink },
  more: { fontSize: 11, color: colors.sub, marginLeft: 4, fontWeight: "600" },
});
