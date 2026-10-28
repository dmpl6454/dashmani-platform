import React, { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, Linking, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

// Posting watch — the internal dashboard's card (GET /admin/meta/posting-watch, admins only):
// assigned Facebook / Instagram channels with no new post for 2 h+ inside the 07:00–23:00 IST
// window. A flag always means Meta itself was asked after the deadline; a channel that can't
// be checked is listed under "Can't check", never as a gap. Read-only and DB-only — opening
// this screen never calls Meta.

type Group = "quiet_today" | "no_post_today" | "inactive" | "cant_check";
type Tab = Group | "not_connected";
type ErrorKind = "token" | "permission" | "not_found" | "rate_limited" | "unreachable" | "meta_error";
type Person = { id: string; name: string };
type Channel = {
  key: string;
  platform: "facebook" | "instagram";
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
type NotConnected = { accountId: string; platform: "facebook" | "instagram"; name: string; handle: string; reason: "no_page" | "ambiguous"; assignees: Person[] };
type Payload = {
  status: "ok" | "off" | "paused" | "unavailable";
  now: string;
  asOf: string;
  window: { start: string; end: string; active: boolean; nextStart: string; startMinute: number; endMinute: number };
  thresholdMinutes: number;
  stale: boolean;
  monitor: { configured: boolean; pausedUntil: string | null; lastCheckAt: string | null; lastSuccessAt: string | null; verifyingSince: string | null };
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

/** Clock time in IST, e.g. "9:05 PM", with the day when it isn't today (IST). */
function istWhen(iso: string | null, nowMs: number): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...o });
  const day = (ms: number) => fmt(ms, { year: "numeric", month: "2-digit", day: "2-digit" });
  const clock = fmt(t, { hour: "numeric", minute: "2-digit", hour12: true });
  if (day(t) === day(nowMs)) return clock;
  if (day(t) === day(nowMs - 86_400_000)) return `yesterday ${clock}`;
  return `${fmt(t, { day: "numeric", month: "short" })} ${clock}`;
}

function clockFromMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
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

export default function PostingWatch() {
  const { data, loading, refreshing, error, refresh } = useApi<Payload>(() => apiFetch("/admin/meta/posting-watch"));
  const [tab, setTab] = useState<Tab | null>(null);
  const [platform, setPlatform] = useState<"all" | "facebook" | "instagram">("all");
  const [query, setQuery] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());

  // The list itself refreshes every minute; the clock runs from the server's own "now".
  useEffect(() => {
    const t = setInterval(() => refresh(), 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (data?.now) setNowMs(new Date(data.now).getTime());
  }, [data?.now]);

  const counts = data?.counts ?? null;
  const firstNonEmpty: Tab = useMemo(() => TABS.find((t) => (counts?.[t] ?? 0) > 0) ?? "quiet_today", [counts]);
  const current: Tab = tab ?? firstNonEmpty;

  const q = query.trim().toLowerCase();
  const match = (r: { platform: string; name: string; assignees: Person[] }) =>
    (platform === "all" || r.platform === platform) &&
    (q === "" || r.name.toLowerCase().includes(q) || r.assignees.some((a) => a.name.toLowerCase().includes(q)));

  if (loading && !data) return <Loading />;

  if (!data || data.status !== "ok" || !counts) {
    const text = !data
      ? error ?? "Couldn't read the posting watch."
      : data.status === "off"
        ? "Posting watch is switched off."
        : data.status === "paused"
          ? "Posting watch is waiting for a one-time database update. It will start on its own once that's done."
          : "Couldn't read the posting watch just now. Pull to retry.";
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        <Card><Text style={styles.body}>{text}</Text></Card>
      </Screen>
    );
  }

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
  const late = active && data.monitor.configured && !paused && verifyingSince != null && nowMs - verifyingSince > 10 * MINUTE;

  const rows = current === "not_connected" ? [] : data.channels.filter((c) => c.group === current).filter(match);
  const nc = current === "not_connected" ? data.notConnected.filter(match) : [];
  const silentTab = current === "quiet_today" || current === "no_post_today" || current === "inactive";

  let emptyText: string;
  if (q || platform !== "all") emptyText = "Nothing here matches these filters.";
  else if (silentTab && beforeFirstFlag)
    emptyText = `No channel can be overdue before ${istWhen(new Date(firstFlagAt).toISOString(), nowMs)}. Channels with no post since ${startLabel} are flagged from then.`;
  else if (silentTab && (counts.verifying ?? 0) > 0) emptyText = `Checking ${counts.verifying} channel${counts.verifying === 1 ? "" : "s"} now.`;
  else
    emptyText = {
      quiet_today: "No assigned channel is flagged as gone quiet.",
      no_post_today: `No assigned channel is flagged for having no post since ${startLabel}.`,
      inactive: "No assigned channel is flagged as inactive for 7 days.",
      cant_check: "Every assigned channel can be checked.",
      not_connected: "Every assigned Facebook and Instagram channel is connected.",
    }[current];

  const hint = {
    quiet_today: `Posted earlier today, then nothing for ${gapText(data.thresholdMinutes)} or more.`,
    no_post_today: `Nothing posted since ${startLabel} today. Overnight silence doesn't count.`,
    inactive: "No post in 7 days or more.",
    cant_check: "Meta wouldn't let us check these, or Meta is failing. A channel that can't be checked is never counted as a gap.",
    not_connected: "Assigned in the portal, but no connected Page or Instagram account matches them on Account Growth.",
  }[current];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Text style={styles.subtitle}>
        Assigned channels with no new post for {gapText(data.thresholdMinutes)} or more, checked {startLabel}–{endLabel} IST.
      </Text>
      <View style={[styles.status, { backgroundColor: !data.monitor.configured ? colors.amberSoft : active ? colors.greenSoft : colors.cardHigh }]}>
        <Ionicons
          name={!data.monitor.configured ? "warning-outline" : active ? "radio-button-on" : "moon-outline"}
          size={14}
          color={!data.monitor.configured ? colors.amber : active ? colors.green : colors.sub}
        />
        <Text style={styles.statusText}>
          {!data.monitor.configured
            ? "Not connected to Meta — nothing is being checked"
            : active
              ? `Live${lastSuccess != null && lastSuccess >= windowStart ? ` · checked ${ago(nowMs - lastSuccess)}` : ""}`
              : `Paused overnight · resumes ${istWhen(data.window.nextStart, nowMs)}`}
        </Text>
      </View>

      {data.stale ? <ErrorBanner message={`Couldn't refresh just now. Showing the update from ${istWhen(data.asOf, nowMs)}. Pull to retry.`} /> : null}
      {paused ? <ErrorBanner message={`Meta asked us to slow down, so checks resume at ${istWhen(data.monitor.pausedUntil, nowMs)}.`} /> : null}
      {late ? <ErrorBanner message={`Checks are running behind — some channels have waited since ${istWhen(data.monitor.verifyingSince, nowMs)}. The list will catch up.`} /> : null}

      <Chips
        options={TABS}
        value={current}
        onChange={(t) => setTab(t)}
        labels={Object.fromEntries(TABS.map((t) => [t, `${LABEL[t]} ${counts[t] ?? 0}`])) as Record<Tab, string>}
      />
      <Chips options={["all", "facebook", "instagram"] as const} value={platform} onChange={setPlatform} labels={{ all: "All", facebook: "Facebook", instagram: "Instagram" }} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search channels or people"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        style={styles.search}
      />
      <Text style={styles.hint}>{hint}</Text>

      <Card>
        {current === "not_connected" ? (
          nc.length === 0 ? (
            <Empty icon="checkmark-circle-outline" text={emptyText} />
          ) : (
            nc.map((r, i) => (
              <View key={r.accountId} style={[styles.row, i === nc.length - 1 && { borderBottomWidth: 0 }]}>
                <Ionicons name={r.platform === "instagram" ? "logo-instagram" : "logo-facebook"} size={18} color={colors.sub} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
                  <Text style={styles.sub} numberOfLines={1}>@{r.handle.replace(/^@/, "")} · {people(r.assignees)}</Text>
                  <Text style={styles.detail}>
                    {r.reason === "ambiguous" ? "Matches Pages of more than one channel — can't tell which to watch." : "No connected Page or account matches it."}
                  </Text>
                </View>
              </View>
            ))
          )
        ) : rows.length === 0 ? (
          <Empty icon="checkmark-circle-outline" text={emptyText} />
        ) : (
          rows.map((c, i) => {
            let detail: string;
            if (c.group === "cant_check") {
              detail = `${c.errorKind ? ERROR_COPY[c.errorKind] : "Can't be checked right now."}${c.errorSince ? ` Since ${istWhen(c.errorSince, nowMs)}.` : ""}`;
              if (c.errorKind && NEEDS_A_HUMAN.has(c.errorKind) && c.errorDetail) detail += `\nMeta said: ${c.errorDetail}`;
            } else if (c.group === "inactive") {
              detail = c.lastPostAt ? `Last post ${istWhen(c.lastPostAt, nowMs)}` : "No posts found on Meta.";
            } else if (c.group === "no_post_today") {
              detail = `Nothing since ${startLabel} · ${c.lastPostAt ? `last post ${istWhen(c.lastPostAt, nowMs)}` : "no earlier post found"}`;
            } else {
              detail = `Last post ${istWhen(c.lastPostAt, nowMs)}`;
            }
            return (
              <Pressable key={c.key} disabled={!c.href} onPress={() => c.href && Linking.openURL(c.href)}>
                <View style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
                  <Ionicons name={c.platform === "instagram" ? "logo-instagram" : "logo-facebook"} size={18} color={colors.sub} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={[styles.name, { flexShrink: 1 }]} numberOfLines={1}>{c.name}</Text>
                      {c.pages.length > 1 ? <Text style={styles.badge}>{c.pages.length} Pages</Text> : null}
                    </View>
                    <Text style={styles.sub} numberOfLines={1}>{people(c.assignees)}</Text>
                    <Text style={[styles.detail, c.group === "cant_check" && { color: colors.amber }]}>{detail}</Text>
                  </View>
                  {c.lastPostUrl ? (
                    <Pressable hitSlop={8} onPress={() => Linking.openURL(c.lastPostUrl!)}>
                      <Text style={styles.link}>view</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Pressable>
            );
          })
        )}
      </Card>
      <Text style={styles.foot}>
        {counts.monitored ?? 0} channels watched · {counts.onSchedule ?? 0} on schedule
        {(counts.verifying ?? 0) > 0 ? ` · ${counts.verifying} being confirmed` : ""}. A channel with several Pages counts as posting when any of them posts.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: 13, color: colors.sub, marginBottom: spacing.sm, lineHeight: 18 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full, marginBottom: spacing.md },
  statusText: { fontSize: 12, fontWeight: "600", color: colors.ink },
  body: { fontSize: 14, color: colors.ink, lineHeight: 20 },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 12,
    height: 40,
    fontSize: 15,
    color: colors.ink,
    marginBottom: spacing.sm,
  },
  hint: { fontSize: 12, color: colors.sub, marginBottom: spacing.sm, lineHeight: 17 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 14, fontWeight: "600", color: colors.ink },
  sub: { fontSize: 11, color: colors.sub, marginTop: 2 },
  detail: { fontSize: 12, color: colors.ink, marginTop: 4, lineHeight: 17 },
  badge: { fontSize: 10, fontWeight: "700", color: colors.sub, borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: 6, paddingVertical: 1 },
  link: { fontSize: 13, fontWeight: "600", color: colors.purple },
  foot: { fontSize: 11, color: colors.faint, marginTop: 6, lineHeight: 16 },
});
