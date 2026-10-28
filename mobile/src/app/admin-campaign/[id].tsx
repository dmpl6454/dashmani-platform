import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Image, Linking, Alert } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE, fmtDate, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";
import { BOOKING_STATUS, ITEM_STATUS, PLATFORM_LABEL, formatLabel, rupees } from "@/lib/campaigns";

// One campaign booking for staff — internal portal /campaigns/[id] (Admin / Super Admin only).
// Same actions and the same guards as the web page; every action that refunds, rejects or
// drops something asks first. Posting by hand stays a desktop job (downloading the files);
// here staff review, approve and record the link once the post is live.

type Item = {
  id: string;
  platform: string;
  format: string;
  accountName: string;
  accountHandle: string | null;
  pricePaise: number;
  audioAddonPaise: number;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  permalink: string | null;
  postedAt: string | null;
  lastError: string | null;
  captionOverride: string | null;
  superTextOverride: string | null;
};
type Booking = {
  id: string;
  name: string;
  brand: string;
  objective: string | null;
  campaignType: string;
  audioIntegration: boolean;
  audioTrack: string | null;
  launchFrom: string | null;
  launchTo: string | null;
  format: string | null;
  caption: string | null;
  hashtags: string[];
  superText: string | null;
  status: string;
  totalPaise: number;
  reviewNote: string | null;
  paidAt: string | null;
  client: { companyName: string; contactName: string; email: string; phone: string | null };
  media: Array<{ id: string; kind: string; role: string; renderStatus: string }>;
  items: Item[];
  payments: unknown[];
  events: Array<{ id: string; actorType: string; toStatus: string | null; note: string | null; createdAt: string }>;
  autoPublish: { enabled: boolean; dueAt: string | null };
};
type MediaUrls = { media: Array<{ id: string; kind: string; role: string; renderStatus: string; preview: string | null; original: string | null }> };

export default function AdminCampaign() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const { data: b, loading, refreshing, error, refresh, reload } = useApi<Booking>(async () => {
    const r = await apiFetch<Booking>(`/admin/campaigns/${id}`);
    navigation.setOptions({ title: r.name });
    return r;
  }, [id]);
  const { data: urls } = useApi<MediaUrls>(() => apiFetch(`/admin/campaigns/${id}/media-urls`), [id]);

  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [failing, setFailing] = useState<string | null>(null);
  const [failNote, setFailNote] = useState("");

  if (loading && !b) return <Loading />;
  if (!b) return <Screen onRefresh={refresh} refreshing={refreshing}><ErrorBanner message={error ?? "Campaign not found"} /></Screen>;

  // No online payment on a submitted booking = it is settled offline (refund becomes "drop").
  const offline = b.payments.length === 0 && !["draft", "awaiting_payment"].includes(b.status);
  const reviewable = b.status === "paid_pending_review";
  const rejectable = ["paid_pending_review", "changes_requested", "approved"].includes(b.status);
  const postable = ["approved", "publishing", "completed", "partially_published"].includes(b.status);
  const st = BOOKING_STATUS[b.status] ?? { label: b.status, color: colors.sub };

  /** POST an action; `confirm` (title, message) asks first. Returns true on success. */
  const act = (key: string, path: string, body?: unknown, okText?: string, confirm?: [string, string]) =>
    new Promise<boolean>((resolve) => {
      const run = async () => {
        setBusy(key);
        setErr(null);
        setMsg(null);
        try {
          await apiFetch(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
          if (okText) setMsg(okText);
          await reload();
          resolve(true);
        } catch (e: any) {
          setErr(e?.message || "That didn't work. Try again.");
          resolve(false);
        } finally {
          setBusy(null);
        }
      };
      if (!confirm) return void run();
      Alert.alert(confirm[0], confirm[1], [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Confirm", style: "destructive", onPress: () => void run() },
      ]);
    });

  const creatives = (urls?.media ?? []).filter((m) => m.role !== "thumbnail");
  const thumb = (urls?.media ?? []).find((m) => m.role === "thumbnail");

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <View style={[styles.pill, { backgroundColor: st.color + "26", alignSelf: "flex-start" }]}>
        <Text style={[styles.pillText, { color: st.color }]}>{st.label}</Text>
      </View>
      <ErrorBanner message={err} />
      <SuccessBanner message={msg} />

      <Card>
        <Kv k="Client" v={`${b.client.companyName} · ${b.client.contactName}`} />
        <Kv k="Contact" v={[b.client.email, b.client.phone].filter(Boolean).join(" · ")} />
        <Kv k="Brand" v={b.brand} />
        <Kv k="Type" v={b.campaignType === "entertainment" ? "Entertainment (film, OTT, music)" : "Brand promotion"} />
        <Kv k="Window" v={b.launchFrom ? `${fmtDate(b.launchFrom)} – ${fmtDate(b.launchTo)}` : "—"} />
        <Kv k="Total" v={`${rupees(b.totalPaise)}${offline ? " · to collect offline" : b.paidAt ? " · paid online" : ""}`} />
        {b.audioIntegration ? <Kv k="Song" v={b.audioTrack || "Yes"} /> : null}
        {b.objective ? <Kv k="Objective" v={b.objective} /> : null}
        {b.reviewNote ? <Kv k="Review note" v={b.reviewNote} /> : null}
      </Card>

      <SectionTitle>Content</SectionTitle>
      <Card>
        <View style={styles.mediaRow}>
          {creatives.length === 0 ? (
            <Text style={styles.muted}>No files.</Text>
          ) : (
            creatives.map((m, n) =>
              m.preview && m.kind === "image" ? (
                <Pressable key={m.id} onPress={() => Linking.openURL(API_BASE + m.preview)}>
                  <Image source={{ uri: API_BASE + m.preview }} style={styles.media} />
                </Pressable>
              ) : (
                <Pressable key={m.id} disabled={!m.preview} onPress={() => m.preview && Linking.openURL(API_BASE + m.preview)} style={[styles.media, styles.mediaVideo]}>
                  <Ionicons name={m.preview ? "play-circle" : "hourglass-outline"} size={28} color={colors.purple} />
                  <Text style={styles.mediaLabel}>{m.preview ? `Play ${creatives.length > 1 ? n + 1 : ""}` : m.renderStatus === "failed" ? "Render failed" : "Preparing…"}</Text>
                </Pressable>
              ),
            )
          )}
          {thumb?.preview ? (
            <Pressable onPress={() => Linking.openURL(API_BASE + thumb.preview)}>
              <Image source={{ uri: API_BASE + thumb.preview }} style={styles.media} />
              <Text style={styles.mediaLabel}>Thumbnail</Text>
            </Pressable>
          ) : null}
        </View>
        <Kv k="Format" v={b.format ?? "—"} />
        {b.superText ? <Kv k="Printed text" v={b.superText} /> : null}
        <Kv k="Caption" v={b.caption || "—"} />
        {b.hashtags.length ? <Kv k="Hashtags" v={b.hashtags.map((h) => `#${h}`).join(" ")} /> : null}
      </Card>

      {(reviewable || rejectable) && (
        <>
          <SectionTitle>Review</SectionTitle>
          <Card>
            {reviewable ? (
              <Button
                title="Approve"
                loading={busy === "approve"}
                disabled={!!busy}
                onPress={() =>
                  act("approve", `/admin/campaigns/${b.id}/approve`, undefined, "Approved — the accounts are queued to post.", [
                    "Approve this campaign?",
                    `${b.items.length} account${b.items.length === 1 ? "" : "s"} will be queued to post.`,
                  ])
                }
              />
            ) : null}
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Note to the client (needed to request changes or reject)"
              placeholderTextColor={colors.faint}
              multiline
              style={styles.note}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              {reviewable ? (
                <Button
                  title="Request changes"
                  variant="secondary"
                  small
                  style={{ flex: 1 }}
                  disabled={!!busy || note.trim().length < 3}
                  loading={busy === "changes"}
                  onPress={async () => {
                    if (await act("changes", `/admin/campaigns/${b.id}/request-changes`, { note: note.trim() }, "Changes requested — the client was told.")) setNote("");
                  }}
                />
              ) : null}
              <Button
                title="Reject"
                variant="danger"
                small
                style={{ flex: 1 }}
                disabled={!!busy || note.trim().length < 3}
                loading={busy === "reject"}
                onPress={async () => {
                  const ok = await act("reject", `/admin/campaigns/${b.id}/reject`, { note: note.trim() }, "Rejected.", [
                    "Reject this campaign?",
                    offline ? `Reject the booking from ${b.client.companyName}?` : `Reject and refund ${rupees(b.totalPaise)} to ${b.client.companyName}?`,
                  ]);
                  if (ok) setNote("");
                }}
              />
            </View>
          </Card>
        </>
      )}

      <SectionTitle>Accounts ({b.items.length})</SectionTitle>
      {postable && b.items.some((i) => i.status === "queued") && !b.autoPublish.enabled ? (
        <Text style={styles.warn}>Auto-publishing is switched off — accounts marked Auto-publish won't post by themselves. Choose "Post by hand instead" on each.</Text>
      ) : null}
      <Card>
        {b.items.map((i, n) => {
          const ist = ITEM_STATUS[i.status] ?? { label: i.status, color: colors.sub };
          const open = ["manual_pending", "queued", "failed"].includes(i.status);
          const queued = i.status === "queued";
          const live = i.status === "posted_manual" || i.status === "published";
          const link = links[i.id] ?? i.permalink ?? "";
          return (
            <View key={i.id} style={[styles.item, n === b.items.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {i.accountName}
                    {i.accountHandle ? <Text style={styles.muted}> @{i.accountHandle.replace(/^@/, "")}</Text> : null}
                  </Text>
                  <Text style={styles.muted}>
                    {PLATFORM_LABEL[i.platform] ?? i.platform} · {formatLabel(i.platform, i.format)} · {rupees(i.pricePaise)}
                    {i.audioAddonPaise > 0 ? ` (incl. ${rupees(i.audioAddonPaise)} song)` : ""}
                    {i.postedAt ? ` · posted ${fmtDateTime(i.postedAt)}` : ""}
                  </Text>
                </View>
                <View style={[styles.pill, { backgroundColor: ist.color + "26" }]}>
                  <Text style={[styles.pillText, { color: ist.color }]}>{ist.label}</Text>
                </View>
                {i.permalink ? (
                  <Pressable hitSlop={8} onPress={() => Linking.openURL(i.permalink!)}>
                    <Ionicons name="open-outline" size={16} color={colors.purple} />
                  </Pressable>
                ) : null}
              </View>
              {i.captionOverride != null ? <Text style={styles.small}>Own caption: {i.captionOverride || "(hashtags only)"}</Text> : null}
              {i.superTextOverride != null ? <Text style={styles.small}>Own printed text: {i.superTextOverride || "none"}</Text> : null}
              {queued ? (
                <Text style={styles.small}>
                  {!b.autoPublish.enabled
                    ? "Auto-publishing is off — this won't post by itself."
                    : i.nextAttemptAt && new Date(i.nextAttemptAt) > new Date()
                      ? `Posts automatically ${fmtDateTime(i.nextAttemptAt)}`
                      : "Publishing through the API now…"}
                  {b.autoPublish.enabled && i.attempts > 0 ? ` · attempt ${i.attempts + 1} of 5` : ""}
                </Text>
              ) : null}
              {i.lastError && i.status !== "refunded" && i.status !== "posted_manual" ? (
                <Text style={[styles.small, { color: i.status === "manual_pending" ? colors.yellow : queued ? colors.sub : colors.red }]}>
                  {queued ? `Last try: ${i.lastError}` : i.status === "manual_pending" ? `Post by hand — ${i.lastError}` : i.lastError}
                </Text>
              ) : null}

              {postable && !queued && (open || live) ? (
                <View style={styles.linkRow}>
                  <TextInput
                    value={link}
                    onChangeText={(v) => setLinks((s) => ({ ...s, [i.id]: v }))}
                    placeholder={`Paste the ${PLATFORM_LABEL[i.platform] ?? i.platform} post link`}
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    style={styles.linkInput}
                  />
                  <Button
                    title={live ? "Save" : "Posted"}
                    small
                    disabled={!!busy || !link.trim() || link.trim() === i.permalink}
                    loading={busy === `post-${i.id}`}
                    onPress={() => act(`post-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/posted`, { url: link.trim() }, `Link saved for ${i.accountName}.`)}
                  />
                </View>
              ) : null}

              {postable ? (
                <View style={styles.actions}>
                  {queued ? (
                    <>
                      <TextAction label="Publish now" onPress={() => act(`now-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/publish-now`, undefined, "Publishing now.")} disabled={!!busy} />
                      <TextAction label="Post by hand instead" onPress={() => act(`manual-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/manual`, undefined, "Moved to post by hand.")} disabled={!!busy} />
                    </>
                  ) : null}
                  {b.autoPublish.enabled && i.status === "manual_pending" ? (
                    <TextAction label="Try auto-publish" onPress={() => act(`now-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/publish-now`, undefined, "Queued to publish.")} disabled={!!busy} />
                  ) : null}
                  {i.status === "manual_pending" || queued ? (
                    <TextAction label="Mark failed" onPress={() => { setFailing(failing === i.id ? null : i.id); setFailNote(""); }} disabled={!!busy} />
                  ) : null}
                  {open ? (
                    <TextAction
                      danger
                      label={offline ? "Drop this account" : "Refund this account"}
                      disabled={!!busy}
                      onPress={() =>
                        act(`refund-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/refund`, undefined, offline ? "Account dropped." : "Refund started.", [
                          offline ? "Drop this account?" : "Refund this account?",
                          offline
                            ? `Drop ${i.accountName} (${rupees(i.pricePaise)})? It won't be posted and won't be charged.`
                            : `Refund ${rupees(i.pricePaise)} for ${i.accountName}? It won't be posted.`,
                        ])
                      }
                    />
                  ) : null}
                </View>
              ) : null}

              {failing === i.id ? (
                <View style={styles.linkRow}>
                  <TextInput
                    value={failNote}
                    onChangeText={setFailNote}
                    placeholder="Why couldn't it be posted?"
                    placeholderTextColor={colors.faint}
                    style={styles.linkInput}
                  />
                  <Button
                    title="Mark failed"
                    variant="danger"
                    small
                    disabled={!!busy || failNote.trim().length < 3}
                    loading={busy === `fail-${i.id}`}
                    onPress={async () => {
                      const ok = await act(`fail-${i.id}`, `/admin/campaigns/${b.id}/items/${i.id}/failed`, { note: failNote.trim() }, "Marked failed.", [
                        "Mark as failed?",
                        `${i.accountName} will be recorded as not posted.`,
                      ]);
                      if (ok) setFailing(null);
                    }}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>

      {["completed", "partially_published"].includes(b.status) ? (
        <Button
          title="Resend delivery email"
          variant="secondary"
          style={{ marginTop: spacing.md }}
          loading={busy === "resend"}
          disabled={!!busy}
          onPress={() => act("resend", `/admin/campaigns/${b.id}/resend-delivery`, undefined, `Delivery email sent to ${b.client.email}.`, ["Resend the delivery email?", `It goes to ${b.client.email}.`])}
        />
      ) : null}

      <SectionTitle>History</SectionTitle>
      <Card>
        {b.events.map((e, n) => (
          <View key={e.id} style={[styles.event, n === b.events.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={styles.small}>{fmtDateTime(e.createdAt)} · {e.actorType}{e.toStatus ? ` → ${BOOKING_STATUS[e.toStatus]?.label ?? e.toStatus}` : ""}</Text>
            {e.note ? <Text style={styles.eventNote}>{e.note}</Text> : null}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} selectable>{v}</Text>
    </View>
  );
}

function TextAction({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} style={({ pressed }) => ({ opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}>
      <Text style={[styles.textAction, danger && { color: colors.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, marginBottom: spacing.sm },
  pillText: { fontSize: 11, fontWeight: "700" },
  kv: { flexDirection: "row", gap: 10, paddingVertical: 5 },
  k: { width: 92, fontSize: 12, color: colors.sub },
  v: { flex: 1, fontSize: 13, color: colors.ink, lineHeight: 18 },
  muted: { fontSize: 12, color: colors.sub, fontWeight: "400" },
  mediaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: spacing.sm },
  media: { width: 96, height: 128, borderRadius: 10, backgroundColor: colors.cardHigh },
  mediaVideo: { alignItems: "center", justifyContent: "center", gap: 4 },
  mediaLabel: { fontSize: 11, color: colors.sub, textAlign: "center", marginTop: 2 },
  note: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    padding: 10,
    fontSize: 14,
    color: colors.ink,
    marginVertical: spacing.sm,
    textAlignVertical: "top",
  },
  warn: { fontSize: 12, color: colors.yellow, marginBottom: spacing.sm, lineHeight: 17 },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 4 },
  name: { fontSize: 14, fontWeight: "600", color: colors.ink },
  small: { fontSize: 12, color: colors.sub, lineHeight: 17 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  linkInput: {
    flex: 1,
    height: 38,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 10,
    fontSize: 13,
    color: colors.ink,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 6 },
  textAction: { fontSize: 13, fontWeight: "600", color: colors.purple },
  event: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  eventNote: { fontSize: 13, color: colors.ink, marginTop: 2 },
});
