import React, { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { addDaysISO, apiFetch, fmtDay, fmtTime, istDateOf } from "@/lib/api";
import { colors, radius, sizes, spacing, toneColors, type } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import { Card, Chips, Empty, ErrorBanner, Field, IconButton, Loading, Screen, useApi } from "@/components/ui";
import type { IoniconName } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { toast } from "@/components/feedback";

// Posting watch — the internal dashboard's card (GET /admin/meta/posting-watch, admins only):
// assigned Facebook / Instagram channels with no new post for 2 h+ inside the 07:00–23:00 IST
// window. A flag always means Meta itself was asked after the deadline; a channel that can't
// be checked is listed under "Can't check", never as a gap. Read-only and DB-only — opening
// this screen never calls Meta.

type Group = "quiet_today" | "no_post_today" | "inactive" | "cant_check";
type Tab = Group | "not_connected";
type ErrorKind = "token" | "permission" | "not_found" | "rate_limited" | "unreachable" | "meta_error";
type Person = { id: string; name: string };
type ChannelPlatform = "facebook" | "instagram";
type Channel = {
  key: string;
  platform: ChannelPlatform;
  name: string;
  href: string | null;
  pages: Array<{ metaId: string; name: string; href: string | null }>;
  assignees: Person[];
  group: Group;
  lastPostAt: string | null;
  lastPostUrl: string | null;
  silentSince: string | null;
  checkedAt: string | null;
  errorKind: ErrorKind | null;
  errorDetail: string | null;
  errorSince: string | null;
};
type NotConnected = {
  accountId: string;
  platform: ChannelPlatform;
  name: string;
  handle: string;
  reason: "no_page" | "ambiguous";
  assignees: Person[];
};
type Payload = {
  status: "ok" | "off" | "paused" | "unavailable";
  now: string;
  asOf: string;
  window: { start: string; end: string; active: boolean; nextStart: string; startMinute: number; endMinute: number };
  thresholdMinutes: number;
  stale: boolean;
  monitor: {
    configured: boolean;
    pausedUntil: string | null;
    lastCheckAt: string | null;
    lastSuccessAt: string | null;
    verifyingSince: string | null;
  };
  counts: Record<Group | "not_connected" | "verifying" | "monitored" | "onSchedule", number> | null;
  channels: Channel[];
  notConnected: NotConnected[];
};

const TABS: Tab[] = ["quiet_today", "no_post_today", "inactive", "cant_check", "not_connected"];
const LABEL: Record<Tab, string> = {
  quiet_today: "Went quiet",
  no_post_today: "No post today",
  inactive: "Inactive 7d+",
  cant_check: "Can't check",
  not_connected: "Not connected",
};
const PLATFORMS = ["all", "facebook", "instagram"] as const;
type PlatformFilter = (typeof PLATFORMS)[number];
const PLATFORM_LABELS: Record<PlatformFilter, string> = { all: "All", facebook: "Facebook", instagram: "Instagram" };
const ERROR_COPY: Record<ErrorKind, string> = {
  token: "Meta access has expired. Reconnect on Account Growth.",
  permission: "No admin access to this Page on Meta (or 2-step verification is required).",
  not_found: "Meta can't find this Page any more.",
  rate_limited: "Meta asked us to slow down. Retrying.",
  unreachable: "Meta isn't responding. Retrying.",
  meta_error: "Meta returned an error. Retrying.",
};
const NEEDS_A_HUMAN = new Set<ErrorKind>(["token", "permission", "not_found"]);
const MINUTE = 60_000;

/** Clock time in IST, e.g. "9:05 pm", with the day when it isn't today (IST). */
function istWhen(iso: string | null, nowMs: number): string {
  if (!iso) return "unknown";
  const day = istDateOf(iso);
  if (!day) return "unknown";
  const today = istDateOf(new Date(nowMs).toISOString());
  const clock = fmtTime(iso);
  if (day === today) return clock;
  if (today && day === addDaysISO(today, -1)) return `yesterday ${clock}`;
  return `${fmtDay(iso, { weekday: false })} ${clock}`;
}

/** Minutes after IST midnight → "7:00 am" (same style as fmtTime). */
function clockFromMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "am" : "pm"}`;
}

function gapText(min: number): string {
  return min % 60 === 0 ? `${min / 60} hour${min === 60 ? "" : "s"}` : `${min} minutes`;
}

function ago(ms: number): string {
  const m = Math.floor(ms / MINUTE);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

function people(p: Person[]): string {
  if (p.length === 0) return "No one assigned";
  const n = p.map((x) => x.name);
  return n.length <= 3 ? n.join(", ") : `${n.slice(0, 3).join(", ")} +${n.length - 3}`;
}

function openLink(url: string): void {
  Linking.openURL(url).catch(() => {
    toast.show({ message: "Couldn't open this link.", tone: "danger" });
  });
}

function platformGlyph(p: ChannelPlatform): { icon: IoniconName; bg: string; fg: string } {
  return p === "instagram"
    ? { icon: "logo-instagram", bg: colors.pinkSoft, fg: colors.pink }
    : { icon: "logo-facebook", bg: colors.blueSoft, fg: colors.blueText };
}

export default function PostingWatch() {
  const state = useApi<Payload>(() => apiFetch<Payload>("/admin/meta/posting-watch"), []);
  const { reload } = state;

  // The list itself refreshes every minute (silently); the clock runs from the server's own "now".
  useEffect(() => {
    const t = setInterval(() => {
      void reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock state={state} skeleton={<Loading />}>
        {(data) => <WatchBody data={data} onRetry={() => void reload()} />}
      </AsyncBlock>
    </Screen>
  );
}

function Unavailable({ status, onRetry }: { status: Payload["status"]; onRetry: () => void }) {
  if (status === "off") {
    return (
      <Card>
        <Empty icon="pause-circle-outline" title="Posting watch is off" text="Posting watch is switched off." />
      </Card>
    );
  }
  if (status === "paused") {
    return (
      <Card>
        <Empty
          icon="hourglass-outline"
          tone="warning"
          title="Getting ready"
          text="Posting watch is waiting for a one-time database update. It will start on its own once that's done."
        />
      </Card>
    );
  }
  return (
    <Card>
      <Empty
        icon="alert-circle-outline"
        tone="danger"
        title="Couldn't read the posting watch"
        text="Couldn't read the posting watch just now. Try again in a moment."
        action={{ label: "Try again", onPress: onRetry }}
      />
    </Card>
  );
}

function WatchBody({ data, onRetry }: { data: Payload; onRetry: () => void }) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [query, setQuery] = useState("");
  const [nowMs, setNowMs] = useState(() => {
    const t = new Date(data.now).getTime();
    return Number.isFinite(t) ? t : Date.now();
  });

  useEffect(() => {
    const t = new Date(data.now).getTime();
    if (Number.isFinite(t)) setNowMs(t);
  }, [data.now]);

  const counts = data.counts;
  const firstNonEmpty = useMemo<Tab>(() => TABS.find((t) => (counts?.[t] ?? 0) > 0) ?? "quiet_today", [counts]);
  const current: Tab = tab ?? firstNonEmpty;

  if (data.status !== "ok" || !counts) return <Unavailable status={data.status} onRetry={onRetry} />;

  const q = query.trim().toLowerCase();
  const filtersActive = q !== "" || platform !== "all";
  const match = (r: { platform: string; name: string; assignees: Person[] }) =>
    (platform === "all" || r.platform === platform) &&
    (q === "" || r.name.toLowerCase().includes(q) || r.assignees.some((a) => a.name.toLowerCase().includes(q)));
  const clearFilters = () => {
    setQuery("");
    setPlatform("all");
  };

  const startLabel = clockFromMinutes(data.window.startMinute);
  const endLabel = clockFromMinutes(data.window.endMinute);
  const active = data.window.active;
  const windowStart = new Date(data.window.start).getTime();
  const firstFlagAt = windowStart + data.thresholdMinutes * MINUTE;
  const beforeFirstFlag = active && nowMs < firstFlagAt + MINUTE;
  const pausedUntil = data.monitor.pausedUntil ? new Date(data.monitor.pausedUntil).getTime() : null;
  const paused = pausedUntil != null && pausedUntil > nowMs;
  const lastSuccess = data.monitor.lastSuccessAt ? new Date(data.monitor.lastSuccessAt).getTime() : null;
  const verifyingSince = data.monitor.verifyingSince ? new Date(data.monitor.verifyingSince).getTime() : null;
  const late =
    active && data.monitor.configured && !paused && verifyingSince != null && nowMs - verifyingSince > 10 * MINUTE;

  const rows = current === "not_connected" ? [] : data.channels.filter((c) => c.group === current).filter(match);
  const nc = current === "not_connected" ? data.notConnected.filter(match) : [];
  const silentTab = current === "quiet_today" || current === "no_post_today" || current === "inactive";
  const verifying = counts.verifying ?? 0;

  let empty: { icon: IoniconName; tone: Tone; text: string };
  if (filtersActive) {
    empty = { icon: "search-outline", tone: "neutral", text: "Nothing here matches these filters." };
  } else if (silentTab && beforeFirstFlag) {
    empty = {
      icon: "time-outline",
      tone: "neutral",
      text: `No channel can be overdue before ${istWhen(new Date(firstFlagAt).toISOString(), nowMs)}. Channels with no post since ${startLabel} are flagged from then.`,
    };
  } else if (silentTab && verifying > 0) {
    empty = {
      icon: "time-outline",
      tone: "neutral",
      text: `Checking ${verifying} channel${verifying === 1 ? "" : "s"} now.`,
    };
  } else {
    const text: Record<Tab, string> = {
      quiet_today: "No assigned channel is flagged as gone quiet.",
      no_post_today: `No assigned channel is flagged for having no post since ${startLabel}.`,
      inactive: "No assigned channel is flagged as inactive for 7 days.",
      cant_check: "Every assigned channel can be checked.",
      not_connected: "Every assigned Facebook and Instagram channel is connected.",
    };
    empty = { icon: "checkmark-circle-outline", tone: "success", text: text[current] };
  }

  const hints: Record<Tab, string> = {
    quiet_today: `Posted earlier today, then nothing for ${gapText(data.thresholdMinutes)} or more.`,
    no_post_today: `Nothing posted since ${startLabel} today. Overnight silence doesn't count.`,
    inactive: "No post in 7 days or more.",
    cant_check:
      "Meta wouldn't let us check these, or Meta is failing. A channel that can't be checked is never counted as a gap.",
    not_connected: "Assigned in the portal, but no connected Page or Instagram account matches them on Account Growth.",
  };

  const statusTone: Tone = !data.monitor.configured ? "warning" : active ? "success" : "neutral";
  const tc = toneColors(statusTone);
  const statusIcon: IoniconName = !data.monitor.configured
    ? "warning-outline"
    : active
      ? "radio-button-on"
      : "moon-outline";
  const statusText = !data.monitor.configured
    ? "Not connected to Meta — nothing is being checked"
    : active
      ? `Live${lastSuccess != null && lastSuccess >= windowStart ? ` · checked ${ago(nowMs - lastSuccess)}` : ""}`
      : `Paused overnight · resumes ${istWhen(data.window.nextStart, nowMs)}`;

  const tabCounts: Partial<Record<Tab, number>> = {};
  TABS.forEach((t) => {
    tabCounts[t] = counts[t] ?? 0;
  });

  const emptyCard = (
    <Card>
      <Empty
        compact
        icon={empty.icon}
        tone={empty.tone}
        text={empty.text}
        action={filtersActive ? { label: "Clear filters", onPress: clearFilters } : undefined}
      />
    </Card>
  );

  let list: React.ReactNode;
  if (current === "not_connected") {
    list =
      nc.length === 0 ? (
        emptyCard
      ) : (
        <Card padded={false}>
          {nc.map((r, i) => (
            <ChannelRow
              key={r.accountId}
              platform={r.platform}
              name={r.name}
              subtitle={`@${r.handle.replace(/^@/, "")} · ${people(r.assignees)}`}
              detail={
                r.reason === "ambiguous"
                  ? "Matches Pages of more than one channel — can't tell which to watch."
                  : "No connected Page or account matches it."
              }
              last={i === nc.length - 1}
            />
          ))}
        </Card>
      );
  } else {
    list =
      rows.length === 0 ? (
        emptyCard
      ) : (
        <Card padded={false}>
          {rows.map((c, i) => {
            let detail: string;
            if (c.group === "cant_check") {
              detail = `${c.errorKind ? ERROR_COPY[c.errorKind] : "Can't be checked right now."}${
                c.errorSince ? ` Since ${istWhen(c.errorSince, nowMs)}.` : ""
              }`;
              if (c.errorKind && NEEDS_A_HUMAN.has(c.errorKind) && c.errorDetail) detail += `\nMeta said: ${c.errorDetail}`;
            } else if (c.group === "inactive") {
              detail = c.lastPostAt ? `Last post ${istWhen(c.lastPostAt, nowMs)}` : "No posts found on Meta.";
            } else if (c.group === "no_post_today") {
              detail = `Nothing since ${startLabel} · ${
                c.lastPostAt ? `last post ${istWhen(c.lastPostAt, nowMs)}` : "no earlier post found"
              }`;
            } else {
              detail = `Last post ${istWhen(c.lastPostAt, nowMs)}`;
            }
            const href = c.href;
            return (
              <ChannelRow
                key={c.key}
                platform={c.platform}
                name={c.name}
                pages={c.pages.length}
                subtitle={people(c.assignees)}
                detail={detail}
                warn={c.group === "cant_check"}
                postUrl={c.lastPostUrl}
                onPress={href ? () => openLink(href) : undefined}
                last={i === rows.length - 1}
              />
            );
          })}
        </Card>
      );
  }

  return (
    <>
      <Text maxFontSizeMultiplier={1.6} style={styles.subtitle}>
        Assigned channels with no new post for {gapText(data.thresholdMinutes)} or more, checked {startLabel}–{endLabel}{" "}
        IST.
      </Text>
      <View
        style={[styles.status, { backgroundColor: statusTone === "neutral" ? colors.card : tc.bg }]}
        accessible
        accessibilityLabel={statusText}
      >
        <Ionicons name={statusIcon} size={14} color={statusTone === "neutral" ? colors.sub : tc.fg} />
        <Text maxFontSizeMultiplier={1.3} style={[styles.statusText, { color: tc.text }]}>
          {statusText}
        </Text>
      </View>

      {data.stale ? (
        <ErrorBanner
          message={`Couldn't refresh just now. Showing the update from ${istWhen(data.asOf, nowMs)}.`}
          onRetry={onRetry}
        />
      ) : null}
      {paused ? (
        <ErrorBanner
          message={`Meta asked us to slow down, so checks resume at ${istWhen(data.monitor.pausedUntil, nowMs)}.`}
        />
      ) : null}
      {late ? (
        <ErrorBanner
          message={`Checks are running behind — some channels have waited since ${istWhen(
            data.monitor.verifyingSince,
            nowMs,
          )}. The list will catch up.`}
        />
      ) : null}

      <View style={styles.controls}>
        <Chips
          options={TABS}
          value={current}
          onChange={setTab}
          mode="pills"
          labels={LABEL}
          counts={tabCounts}
          accessibilityLabel="Channel group"
        />
        <Chips
          options={PLATFORMS}
          value={platform}
          onChange={setPlatform}
          labels={PLATFORM_LABELS}
          accessibilityLabel="Platform"
        />
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Search channels or people"
          leading="search-outline"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search channels or people"
        />
      </View>
      <Text maxFontSizeMultiplier={1.6} style={styles.hint}>
        {hints[current]}
      </Text>

      {list}

      <Text maxFontSizeMultiplier={1.6} style={styles.foot}>
        {counts.monitored ?? 0} channels watched · {counts.onSchedule ?? 0} on schedule
        {verifying > 0 ? ` · ${verifying} being confirmed` : ""}. A channel with several Pages counts as posting when any
        of them posts.
      </Text>
    </>
  );
}

type ChannelRowProps = {
  platform: ChannelPlatform;
  name: string;
  subtitle: string;
  detail: string;
  /** detail in warning colour (the "Can't check" group) */
  warn?: boolean;
  pages?: number;
  postUrl?: string | null;
  onPress?: () => void;
  last: boolean;
};

function ChannelRow({ platform, name, subtitle, detail, warn = false, pages = 0, postUrl, onPress, last }: ChannelRowProps) {
  const g = platformGlyph(platform);
  const body = (
    <View style={styles.row}>
      <View style={[styles.tile, { backgroundColor: g.bg }]}>
        <Ionicons name={g.icon} size={sizes.iconGlyph} color={g.fg} />
      </View>
      <View style={[styles.rowBody, last ? null : styles.rowDivider]}>
        <View style={styles.rowText}>
          <View style={styles.titleLine}>
            <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.name}>
              {name}
            </Text>
            {pages > 1 ? (
              <Text maxFontSizeMultiplier={1.3} style={styles.pagesBadge}>
                {pages} Pages
              </Text>
            ) : null}
          </View>
          <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.sub}>
            {subtitle}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={[styles.detail, warn ? styles.detailWarn : null]}>
            {detail}
          </Text>
        </View>
        {postUrl ? (
          <IconButton
            icon="open-outline"
            label={`Open the last post on ${name}`}
            onPress={() => openLink(postUrl)}
            glyph={20}
            tint={colors.purpleText}
          />
        ) : null}
        {onPress ? (
          <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} style={styles.chevron} />
        ) : null}
      </View>
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={`${name}, ${subtitle}, ${detail}`}
      accessibilityHint="Opens the channel"
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  subtitle: { ...type.subhead, color: colors.sub, lineHeight: 20, marginBottom: spacing.md },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  statusText: { ...type.footnote, fontWeight: "600" },
  controls: { gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  hint: { ...type.footnote, color: colors.sub, lineHeight: 18, marginBottom: spacing.md },
  row: { flexDirection: "row", alignItems: "flex-start", paddingLeft: spacing.lg, minHeight: sizes.rowMin },
  tile: {
    width: sizes.iconTile,
    height: sizes.iconTile,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
    marginRight: spacing.md,
  },
  rowBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingRight: spacing.sm,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowText: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { ...type.body, color: colors.ink, flexShrink: 1 },
  pagesBadge: {
    ...type.caption2,
    fontWeight: "700",
    color: colors.sub,
    backgroundColor: colors.cardHigh,
    borderRadius: radius.pill,
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  sub: { ...type.subhead, color: colors.sub, marginTop: 2 },
  detail: { ...type.footnote, color: colors.ink, lineHeight: 18, marginTop: spacing.xs },
  detailWarn: { color: colors.warningText },
  chevron: { marginLeft: 2 },
  pressed: { backgroundColor: colors.pressOverlay },
  foot: { ...type.footnote, color: colors.sub, lineHeight: 18, marginTop: spacing.sm },
});
