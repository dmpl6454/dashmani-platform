import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Image, Linking } from "react-native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, API_BASE, errorMessage, fmtDateTime, fmtMoney, fmtRange } from "@/lib/api";
import { colors, radius, spacing, type, formatStatus } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, ErrorBanner, IconButton, StatusPill, useApi } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard } from "@/components/skeleton";
import { confirm, toast, type ConfirmOptions } from "@/components/feedback";
import { haptic, openFile } from "@/lib/device";
import { BOOKING_STATUS, ITEM_STATUS, PLATFORM_LABEL, formatLabel } from "@/lib/campaigns";

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
type MediaUrl = { id: string; kind: string; role: string; renderStatus: string; preview: string | null; original: string | null };
type MediaUrls = { media: MediaUrl[] };

/** Booking status → the shared status enum whose tone the pill should take. */
const BOOKING_PILL: Record<string, string> = {
  draft: "DRAFT",
  awaiting_payment: "PENDING",
  paid_pending_review: "PENDING",
  changes_requested: "PENDING",
  approved: "QUEUED",
  publishing: "QUEUED",
  completed: "DONE",
  partially_published: "DONE",
  rejected: "REJECTED",
  refunded: "CANCELLED",
  cancelled: "CANCELLED",
  expired: "CANCELLED",
};

/** Item status → the shared status enum whose tone the pill should take. */
const ITEM_PILL: Record<string, string> = {
  pending: "PENDING",
  manual_pending: "TODO",
  queued: "QUEUED",
  posted_manual: "DONE",
  published: "DONE",
  failed: "REJECTED",
  refunded: "CANCELLED",
};

/** Paise → "₹1,23,456". */
function money(paise: number | null | undefined): string {
  return paise == null ? "—" : fmtMoney(paise / 100);
}

function openLink(url: string) {
  Linking.openURL(url).catch(() => toast.show({ message: "Couldn't open that link.", tone: "danger" }));
}

export default function AdminCampaign() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const booking = useApi<Booking>(async () => {
    const r = await apiFetch<Booking>(`/admin/campaigns/${id}`);
    navigation.setOptions({ title: r.name });
    return r;
  }, [id]);
  const urls = useApi<MediaUrls>(() => apiFetch<MediaUrls>(`/admin/campaigns/${id}/media-urls`), [id]);

  const onRefresh = async () => {
    await Promise.all([booking.refresh(), urls.reload()]);
  };

  return (
    <Screen onRefresh={onRefresh} refreshing={booking.refreshing}>
      <AsyncBlock
        state={booking}
        skeleton={
          <>
            <SkeletonCard lines={6} />
            <SkeletonCard lines={4} />
          </>
        }
      >
        {(b) => <CampaignBody b={b} media={urls.data?.media ?? []} reload={booking.reload} />}
      </AsyncBlock>
    </Screen>
  );
}

type ActOptions = {
  /** busy key (drives the spinner on the pressed button) */
  key: string;
  /** where the error is shown: "review", "resend" or `item-<id>` */
  scope: string;
  path: string;
  body?: unknown;
  ok: string;
  ask?: ConfirmOptions;
};

function CampaignBody({ b, media, reload }: { b: Booking; media: MediaUrl[]; reload: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fail, setFail] = useState<{ scope: string; message: string } | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [failing, setFailing] = useState<string | null>(null);
  const [failNote, setFailNote] = useState("");

  // No online payment on a submitted booking = it is settled offline (refund becomes "drop").
  const offline = b.payments.length === 0 && !["draft", "awaiting_payment"].includes(b.status);
  const reviewable = b.status === "paid_pending_review";
  const rejectable = ["paid_pending_review", "changes_requested", "approved"].includes(b.status);
  const postable = ["approved", "publishing", "completed", "partially_published"].includes(b.status);
  const statusLabel = BOOKING_STATUS[b.status]?.label ?? formatStatus(b.status);
  const noteOk = note.trim().length >= 3;

  /** POST an action (asking first when `ask` is set). Resolves true on success. */
  const act = async ({ key, scope, path, body, ok, ask }: ActOptions): Promise<boolean> => {
    if (ask && !(await confirm(ask))) return false;
    setBusy(key);
    setFail(null);
    try {
      await apiFetch(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      void haptic("success");
      toast.show({ message: ok, tone: "success" });
      await reload();
      return true;
    } catch (e) {
      void haptic("error");
      setFail({ scope, message: errorMessage(e, "That didn't work. Try again.") });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const errorFor = (scope: string): string | null => (fail && fail.scope === scope ? fail.message : null);

  const creatives = media.filter((m) => m.role !== "thumbnail");
  const thumb = media.find((m) => m.role === "thumbnail");

  return (
    <>
      <View style={styles.pillRow}>
        <StatusPill status={BOOKING_PILL[b.status] ?? b.status} label={statusLabel} />
      </View>

      <Card>
        <Kv k="Client" v={`${b.client.companyName} · ${b.client.contactName}`} />
        <Kv k="Contact" v={[b.client.email, b.client.phone].filter(Boolean).join(" · ")} />
        <Kv k="Brand" v={b.brand} />
        <Kv k="Type" v={b.campaignType === "entertainment" ? "Entertainment (film, OTT, music)" : "Brand promotion"} />
        <Kv k="Window" v={b.launchFrom ? fmtRange(b.launchFrom, b.launchTo) : "—"} />
        <Kv k="Total" v={`${money(b.totalPaise)}${offline ? " · to collect offline" : b.paidAt ? " · paid online" : ""}`} />
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
            creatives.map((m, n) => {
              const num = creatives.length > 1 ? ` ${n + 1}` : "";
              const preview = m.preview;
              if (preview && m.kind === "image") {
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => void openFile(API_BASE + preview)}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={`Open image${num}`}
                  >
                    <Image source={{ uri: API_BASE + preview }} style={styles.media} />
                  </Pressable>
                );
              }
              return (
                <Pressable
                  key={m.id}
                  disabled={!preview}
                  onPress={() => {
                    if (preview) void openFile(API_BASE + preview);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={preview ? `Play video${num}` : m.renderStatus === "failed" ? "Render failed" : "Video still preparing"}
                  accessibilityState={{ disabled: !preview }}
                  style={[styles.media, styles.mediaVideo]}
                >
                  <Ionicons name={preview ? "play-circle" : "hourglass-outline"} size={28} color={colors.purple} />
                  <Text style={styles.mediaLabel}>
                    {preview ? `Play${num}` : m.renderStatus === "failed" ? "Render failed" : "Preparing…"}
                  </Text>
                </Pressable>
              );
            })
          )}
          {thumb?.preview ? (
            <Pressable
              onPress={() => {
                if (thumb.preview) void openFile(API_BASE + thumb.preview);
              }}
              accessibilityRole="imagebutton"
              accessibilityLabel="Open thumbnail"
            >
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

      {reviewable || rejectable ? (
        <>
          <SectionTitle>Review</SectionTitle>
          <Card>
            {reviewable ? (
              <Button
                title="Approve"
                icon="checkmark-circle-outline"
                loading={busy === "approve"}
                disabled={!!busy}
                onPress={() =>
                  act({
                    key: "approve",
                    scope: "review",
                    path: `/admin/campaigns/${b.id}/approve`,
                    ok: "Approved — the accounts are queued to post.",
                    ask: {
                      title: "Approve this campaign?",
                      message: `${b.items.length} account${b.items.length === 1 ? "" : "s"} will be queued to post.`,
                      confirmLabel: "Approve",
                    },
                  })
                }
              />
            ) : null}
            <Field
              label="Note to the client"
              value={note}
              onChangeText={setNote}
              placeholder="What should the client change, or why is it rejected?"
              hint="Needed to request changes or reject (at least 3 characters)."
              autoCapitalize="sentences"
              multiline
              style={styles.noteField}
            />
            <View style={styles.buttonRow}>
              {reviewable ? (
                <Button
                  title="Request changes"
                  variant="secondary"
                  small
                  style={styles.flex}
                  disabled={!!busy || !noteOk}
                  loading={busy === "changes"}
                  onPress={async () => {
                    const done = await act({
                      key: "changes",
                      scope: "review",
                      path: `/admin/campaigns/${b.id}/request-changes`,
                      body: { note: note.trim() },
                      ok: "Changes requested — the client was told.",
                    });
                    if (done) setNote("");
                  }}
                />
              ) : null}
              <Button
                title="Reject"
                variant="danger"
                small
                style={styles.flex}
                disabled={!!busy || !noteOk}
                loading={busy === "reject"}
                onPress={async () => {
                  const done = await act({
                    key: "reject",
                    scope: "review",
                    path: `/admin/campaigns/${b.id}/reject`,
                    body: { note: note.trim() },
                    ok: "Rejected.",
                    ask: {
                      title: "Reject this campaign?",
                      message: offline
                        ? `Reject the booking from ${b.client.companyName}?`
                        : `Reject and refund ${money(b.totalPaise)} to ${b.client.companyName}?`,
                      confirmLabel: offline ? "Reject" : "Reject and refund",
                      destructive: true,
                    },
                  });
                  if (done) setNote("");
                }}
              />
            </View>
            <ErrorBanner message={errorFor("review")} onDismiss={() => setFail(null)} style={styles.inlineError} />
          </Card>
        </>
      ) : null}

      <SectionTitle>{`Accounts (${b.items.length})`}</SectionTitle>
      {postable && b.items.some((i) => i.status === "queued") && !b.autoPublish.enabled ? (
        <Card variant="tinted" tone="warning" style={styles.warnCard}>
          <Text style={styles.warn}>
            Auto-publishing is switched off — accounts marked Auto-publish won't post by themselves. Choose "Post by hand instead" on each.
          </Text>
        </Card>
      ) : null}
      <Card>
        {b.items.map((i, n) => {
          const itemLabel = ITEM_STATUS[i.status]?.label ?? formatStatus(i.status);
          const platform = PLATFORM_LABEL[i.platform] ?? i.platform;
          const open = ["manual_pending", "queued", "failed"].includes(i.status);
          const queued = i.status === "queued";
          const live = i.status === "posted_manual" || i.status === "published";
          const link = links[i.id] ?? i.permalink ?? "";
          const permalink = i.permalink;
          const scope = `item-${i.id}`;
          return (
            <View key={i.id} style={[styles.item, n === b.items.length - 1 ? styles.itemLast : null]}>
              <View style={styles.itemHead}>
                <View style={styles.itemText}>
                  <Text style={styles.name} numberOfLines={1}>
                    {i.accountName}
                    {i.accountHandle ? <Text style={styles.muted}> @{i.accountHandle.replace(/^@/, "")}</Text> : null}
                  </Text>
                  <Text style={styles.muted}>
                    {platform} · {formatLabel(i.platform, i.format)} · {money(i.pricePaise)}
                    {i.audioAddonPaise > 0 ? ` (incl. ${money(i.audioAddonPaise)} song)` : ""}
                    {i.postedAt ? ` · posted ${fmtDateTime(i.postedAt)}` : ""}
                  </Text>
                </View>
                <StatusPill status={ITEM_PILL[i.status] ?? i.status} label={itemLabel} size="sm" />
                {permalink ? (
                  <IconButton
                    icon="open-outline"
                    label={`Open the ${platform} post for ${i.accountName}`}
                    size={32}
                    glyph={18}
                    tint={colors.purpleText}
                    onPress={() => openLink(permalink)}
                  />
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
                <Text
                  style={[
                    styles.small,
                    { color: i.status === "manual_pending" ? colors.warningText : queued ? colors.sub : colors.redText },
                  ]}
                >
                  {queued ? `Last try: ${i.lastError}` : i.status === "manual_pending" ? `Post by hand — ${i.lastError}` : i.lastError}
                </Text>
              ) : null}

              {postable && !queued && (open || live) ? (
                <View style={styles.linkRow}>
                  <Field
                    value={link}
                    onChangeText={(v) => setLinks((s) => ({ ...s, [i.id]: v }))}
                    placeholder={`Paste the ${platform} post link`}
                    accessibilityLabel={`${platform} post link for ${i.accountName}`}
                    autoCorrect={false}
                    keyboardType="url"
                    style={styles.flex}
                  />
                  <Button
                    title={live ? "Save" : "Posted"}
                    small
                    fullWidth={false}
                    accessibilityLabel={`${live ? "Save link" : "Mark posted"} for ${i.accountName}`}
                    disabled={!!busy || !link.trim() || link.trim() === i.permalink}
                    loading={busy === `post-${i.id}`}
                    onPress={() =>
                      act({
                        key: `post-${i.id}`,
                        scope,
                        path: `/admin/campaigns/${b.id}/items/${i.id}/posted`,
                        body: { url: link.trim() },
                        ok: `Link saved for ${i.accountName}.`,
                      })
                    }
                  />
                </View>
              ) : null}

              {postable ? (
                <View style={styles.actions}>
                  {queued ? (
                    <>
                      <TextAction
                        label="Publish now"
                        a11y={`Publish now — ${i.accountName}`}
                        disabled={!!busy}
                        onPress={() =>
                          void act({
                            key: `now-${i.id}`,
                            scope,
                            path: `/admin/campaigns/${b.id}/items/${i.id}/publish-now`,
                            ok: "Publishing now.",
                          })
                        }
                      />
                      <TextAction
                        label="Post by hand instead"
                        a11y={`Post by hand instead — ${i.accountName}`}
                        disabled={!!busy}
                        onPress={() =>
                          void act({
                            key: `manual-${i.id}`,
                            scope,
                            path: `/admin/campaigns/${b.id}/items/${i.id}/manual`,
                            ok: "Moved to post by hand.",
                          })
                        }
                      />
                    </>
                  ) : null}
                  {b.autoPublish.enabled && i.status === "manual_pending" ? (
                    <TextAction
                      label="Try auto-publish"
                      a11y={`Try auto-publish — ${i.accountName}`}
                      disabled={!!busy}
                      onPress={() =>
                        void act({
                          key: `now-${i.id}`,
                          scope,
                          path: `/admin/campaigns/${b.id}/items/${i.id}/publish-now`,
                          ok: "Queued to publish.",
                        })
                      }
                    />
                  ) : null}
                  {i.status === "manual_pending" || queued ? (
                    <TextAction
                      label="Mark failed"
                      a11y={`Mark failed — ${i.accountName}`}
                      disabled={!!busy}
                      onPress={() => {
                        setFailing(failing === i.id ? null : i.id);
                        setFailNote("");
                      }}
                    />
                  ) : null}
                  {open ? (
                    <TextAction
                      danger
                      label={offline ? "Drop this account" : "Refund this account"}
                      a11y={`${offline ? "Drop" : "Refund"} ${i.accountName}`}
                      disabled={!!busy}
                      onPress={() =>
                        void act({
                          key: `refund-${i.id}`,
                          scope,
                          path: `/admin/campaigns/${b.id}/items/${i.id}/refund`,
                          ok: offline ? "Account dropped." : "Refund started.",
                          ask: {
                            title: offline ? "Drop this account?" : "Refund this account?",
                            message: offline
                              ? `Drop ${i.accountName} (${money(i.pricePaise)})? It won't be posted and won't be charged.`
                              : `Refund ${money(i.pricePaise)} for ${i.accountName}? It won't be posted.`,
                            confirmLabel: offline ? "Drop" : "Refund",
                            destructive: true,
                          },
                        })
                      }
                    />
                  ) : null}
                </View>
              ) : null}

              {failing === i.id ? (
                <View style={styles.linkRow}>
                  <Field
                    value={failNote}
                    onChangeText={setFailNote}
                    placeholder="Why couldn't it be posted?"
                    accessibilityLabel={`Why ${i.accountName} couldn't be posted`}
                    autoCapitalize="sentences"
                    style={styles.flex}
                  />
                  <Button
                    title="Mark failed"
                    variant="danger"
                    small
                    fullWidth={false}
                    disabled={!!busy || failNote.trim().length < 3}
                    loading={busy === `fail-${i.id}`}
                    onPress={async () => {
                      const done = await act({
                        key: `fail-${i.id}`,
                        scope,
                        path: `/admin/campaigns/${b.id}/items/${i.id}/failed`,
                        body: { note: failNote.trim() },
                        ok: "Marked failed.",
                        ask: {
                          title: "Mark as failed?",
                          message: `${i.accountName} will be recorded as not posted.`,
                          confirmLabel: "Mark failed",
                          destructive: true,
                        },
                      });
                      if (done) setFailing(null);
                    }}
                  />
                </View>
              ) : null}

              <ErrorBanner message={errorFor(scope)} onDismiss={() => setFail(null)} style={styles.inlineError} />
            </View>
          );
        })}
      </Card>

      {["completed", "partially_published"].includes(b.status) ? (
        <View style={styles.resend}>
          <Button
            title="Resend delivery email"
            variant="secondary"
            icon="mail-outline"
            loading={busy === "resend"}
            disabled={!!busy}
            onPress={() =>
              act({
                key: "resend",
                scope: "resend",
                path: `/admin/campaigns/${b.id}/resend-delivery`,
                ok: `Delivery email sent to ${b.client.email}.`,
                ask: { title: "Resend the delivery email?", message: `It goes to ${b.client.email}.`, confirmLabel: "Resend" },
              })
            }
          />
          <ErrorBanner message={errorFor("resend")} onDismiss={() => setFail(null)} style={styles.inlineError} />
        </View>
      ) : null}

      <SectionTitle>History</SectionTitle>
      <Card>
        {b.events.length === 0 ? (
          <Text style={styles.muted}>No history yet.</Text>
        ) : (
          b.events.map((e, n) => (
            <View key={e.id} style={[styles.event, n === b.events.length - 1 ? styles.itemLast : null]}>
              <Text style={styles.small}>
                {fmtDateTime(e.createdAt)} · {e.actorType}
                {e.toStatus ? ` → ${BOOKING_STATUS[e.toStatus]?.label ?? formatStatus(e.toStatus)}` : ""}
              </Text>
              {e.note ? <Text style={styles.eventNote}>{e.note}</Text> : null}
            </View>
          ))
        )}
      </Card>
    </>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} selectable>
        {v}
      </Text>
    </View>
  );
}

function TextAction({
  label,
  a11y,
  onPress,
  disabled = false,
  danger = false,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.textActionHit, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.textAction, danger ? styles.textActionDanger : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pillRow: { flexDirection: "row", marginBottom: spacing.md },
  kv: { flexDirection: "row", gap: spacing.md, paddingVertical: 5 },
  k: { ...type.footnote, width: 92, color: colors.sub },
  v: { ...type.subhead, flex: 1, color: colors.ink, lineHeight: 20 },
  muted: { ...type.footnote, color: colors.sub },
  mediaRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.sm },
  media: { width: 96, height: 128, borderRadius: radius.md, backgroundColor: colors.cardHigh },
  mediaVideo: { alignItems: "center", justifyContent: "center", gap: spacing.xs },
  mediaLabel: { ...type.caption2, color: colors.sub, textAlign: "center", marginTop: 2 },
  noteField: { marginTop: spacing.md },
  buttonRow: { flexDirection: "row", gap: spacing.sm },
  inlineError: { marginTop: spacing.sm },
  warnCard: { marginBottom: spacing.md },
  warn: { ...type.footnote, color: colors.warningText, lineHeight: 18 },
  item: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: spacing.xs },
  itemLast: { borderBottomWidth: 0 },
  itemHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  itemText: { flex: 1, minWidth: 0 },
  name: { ...type.subhead, fontWeight: "600", color: colors.ink },
  small: { ...type.caption, color: colors.sub, lineHeight: 17 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.lg, marginTop: 2 },
  textActionHit: { minHeight: 36, justifyContent: "center" },
  textAction: { ...type.footnote, fontWeight: "600", color: colors.purpleText },
  textActionDanger: { color: colors.redText },
  resend: { marginTop: spacing.md },
  event: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  eventNote: { ...type.footnote, color: colors.ink, marginTop: 2 },
});
