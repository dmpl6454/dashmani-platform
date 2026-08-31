import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, TextInput, Modal, FlatList } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, todayIST, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, ErrorBanner, SuccessBanner, Empty, Loading } from "@/components/ui";

type Account = { id: string; displayName: string; handle: string; platform?: { name?: string } | string };
type LinkRow = { key: string; url: string; accountId?: string };

let keyCounter = 0;
const newKey = () => `k${++keyCounter}`;

/** Extract URLs from pasted text — tolerant of bare domains, list numbering, commas. */
function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (let raw of text.split(/[\n\r]+/)) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^\d+[.)]\s*/, "").replace(/[,;]+$/, "").trim();
    if (!line) continue;
    // find first http(s):// or bare domain start
    const m = line.match(/https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/i);
    if (!m) continue;
    let url = m[0];
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    if (/\s/.test(url)) continue;
    try {
      const u = new URL(url);
      if (!u.hostname.includes(".")) continue;
      out.push(url);
    } catch {
      // skip unparseable
    }
  }
  return out;
}

function accountLabel(a: Account): string {
  const platform = typeof a.platform === "string" ? a.platform : a.platform?.name ?? "";
  const handle = (a.handle || "").split("?")[0].replace(/^@/, "");
  const name = a.displayName || handle;
  const label = platform ? `${name} · ${platform}` : name;
  return label.length > 34 ? label.slice(0, 33) + "…" : label;
}

export default function ReportScreen() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [submitted, setSubmitted] = useState<any | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [notes, setNotes] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pickerFor, setPickerFor] = useState<"all" | string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const restoredRef = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittingRef = useRef(false);

  const date = todayIST();

  const load = async () => {
    setLoading(true);
    try {
      const [accs, today, draft] = await Promise.allSettled([
        apiFetch<Account[]>("/hr/accounts"),
        apiFetch<any>(`/hr/reports/today`),
        apiFetch<any>(`/hr/reports/draft?date=${date}`),
      ]);
      if (accs.status === "fulfilled") setAccounts(accs.value ?? []);
      const todayReport = today.status === "fulfilled" ? today.value : null;
      setSubmitted(todayReport);

      if (!restoredRef.current) {
        restoredRef.current = true;
        const draftData = draft.status === "fulfilled" ? draft.value : null;
        const existingLinks: LinkRow[] = (todayReport?.links ?? [])
          .filter((l: any) => l.url)
          .map((l: any) => ({ key: newKey(), url: l.url, accountId: l.accountId ?? undefined }));

        // Prefer the newer of draft vs submitted snapshot (draft survives adds after submit)
        const draftNewer =
          draftData?.links?.length &&
          (!todayReport?.submittedAt || (draftData.savedAt && draftData.savedAt > todayReport.submittedAt));
        if (draftNewer) {
          setLinks(
            draftData.links
              .filter((l: any) => l.url)
              .map((l: any) => ({ key: newKey(), url: l.url, accountId: l.accountId ?? undefined })),
          );
          setNotes(draftData.notes ?? "");
        } else if (existingLinks.length) {
          setLinks(existingLinks);
          setNotes(todayReport?.notes ?? "");
        }
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced draft auto-save (3s), mirrors web behavior
  useEffect(() => {
    if (!restoredRef.current || loading) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      const payload = {
        date,
        notes,
        links: links.filter((l) => l.url.trim()).map((l) => ({ url: l.url.trim(), accountId: l.accountId })),
      };
      apiFetch("/hr/reports/draft", { method: "PUT", body: JSON.stringify(payload) }).catch(() => {});
    }, 3000);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, notes]);

  const addRow = () => setLinks((ls) => [...ls, { key: newKey(), url: "" }]);
  const removeRow = (key: string) => setLinks((ls) => ls.filter((l) => l.key !== key));
  const updateUrl = (key: string, url: string) => setLinks((ls) => ls.map((l) => (l.key === key ? { ...l, url } : l)));

  const handlePaste = () => {
    const urls = extractUrls(pasteText);
    if (!urls.length) {
      setError("No links found in the pasted text");
      return;
    }
    setError(null);
    setLinks((ls) => {
      const existing = new Set(ls.map((l) => l.url.trim()));
      const fresh = urls.filter((u) => !existing.has(u));
      const skipped = urls.length - fresh.length;
      if (skipped > 0) setSuccessMsg(`${fresh.length} link(s) added · ${skipped} duplicate(s) skipped`);
      else setSuccessMsg(`${fresh.length} link(s) added`);
      return [...ls, ...fresh.map((u) => ({ key: newKey(), url: u }))];
    });
    setPasteText("");
    setShowPaste(false);
  };

  const assignAccount = (accountId: string | undefined) => {
    if (pickerFor === "all") {
      setLinks((ls) => ls.map((l) => ({ ...l, accountId })));
    } else if (pickerFor) {
      setLinks((ls) => ls.map((l) => (l.key === pickerFor ? { ...l, accountId } : l)));
    }
    setPickerFor(null);
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    const clean = links.map((l) => ({ ...l, url: l.url.trim() })).filter((l) => l.url);
    if (!clean.length) {
      setError("Add at least one link before submitting");
      return;
    }
    // in-form dedupe by URL
    const seen = new Set<string>();
    const deduped = clean.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    submittingRef.current = true;
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const payloadLinks = deduped.map((l) => ({ url: l.url, accountId: l.accountId }));
      const report = await apiFetch<any>("/hr/reports", {
        method: "POST",
        body: JSON.stringify({ date, links: payloadLinks, notes: notes || undefined }),
      });
      // clear draft for the SAME date we just posted
      apiFetch(`/hr/reports/draft?date=${date}`, { method: "DELETE" }).catch(() => {});
      setSubmitted(report);
      const savedCount = (report?.links ?? []).filter((l: any) => !l.isScheduled && l.url).length;
      const skipped = deduped.length - savedCount;
      const dupNote = report?.dedupe?.total
        ? ` · ${report.dedupe.total} duplicate(s) skipped — no links were lost`
        : skipped > 0
          ? ` · ${skipped} duplicate(s) skipped — no links were lost`
          : "";
      setSuccessMsg(`${savedCount} link(s) saved${dupNote}`);
      setLinks((report?.links ?? []).filter((l: any) => l.url).map((l: any) => ({ key: newKey(), url: l.url, accountId: l.accountId ?? undefined })));
    } catch (e: any) {
      setError(e?.message || "Submit failed");
    } finally {
      setSaving(false);
      submittingRef.current = false;
    }
  };

  const liveCount = useMemo(() => links.filter((l) => l.url.trim()).length, [links]);
  const submittedCount = (submitted?.links ?? []).filter((l: any) => !l.isScheduled && l.url).length;

  if (loading) return <Loading />;

  return (
    <Screen onRefresh={load} refreshing={false}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />

      {/* Submitted today */}
      <Card style={{ backgroundColor: submittedCount ? colors.greenSoft : colors.yellowSoft, borderColor: "transparent" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons
            name={submittedCount ? "checkmark-circle" : "time-outline"}
            size={24}
            color={submittedCount ? colors.green : colors.amber}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.subTitle}>
              {submittedCount ? `Submitted today: ${submittedCount} link(s)` : "Nothing submitted yet today"}
            </Text>
            {submitted?.submittedAt ? (
              <Text style={styles.subSub}>Last submitted {fmtDateTime(submitted.submittedAt)}</Text>
            ) : null}
          </View>
        </View>
      </Card>

      {/* Links editor */}
      <SectionTitle
        right={
          <View style={{ flexDirection: "row", gap: 14 }}>
            <Pressable onPress={() => setShowPaste((v) => !v)}>
              <Text style={styles.linkAction}>
                <Ionicons name="clipboard-outline" size={13} /> Paste
              </Text>
            </Pressable>
            {accounts.length > 0 && (
              <Pressable onPress={() => setPickerFor("all")}>
                <Text style={styles.linkAction}>
                  <Ionicons name="at-outline" size={13} /> Assign all
                </Text>
              </Pressable>
            )}
          </View>
        }
      >
        Links ({liveCount})
      </SectionTitle>

      {showPaste && (
        <Card>
          <TextInput
            value={pasteText}
            onChangeText={setPasteText}
            placeholder={"Paste multiple links here —\none per line"}
            placeholderTextColor={colors.faint}
            multiline
            style={styles.pasteBox}
          />
          <Button title="Extract Links" onPress={handlePaste} variant="secondary" small />
        </Card>
      )}

      <Card>
        {links.length === 0 ? (
          <Empty icon="link-outline" text="No links yet — add or paste your posted links" />
        ) : (
          links.map((l, idx) => {
            const acc = accounts.find((a) => a.id === l.accountId);
            return (
              <View key={l.key} style={styles.linkRow}>
                <Text style={styles.linkIndex}>{idx + 1}</Text>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <TextInput
                    value={l.url}
                    onChangeText={(t) => updateUrl(l.key, t)}
                    placeholder="https://…"
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.linkInput}
                  />
                  {accounts.length > 0 && (
                    <Pressable onPress={() => setPickerFor(l.key)}>
                      <Text style={styles.accountTag} numberOfLines={1}>
                        {acc ? accountLabel(acc) : "Tap to pick account"}
                      </Text>
                    </Pressable>
                  )}
                </View>
                <Pressable onPress={() => removeRow(l.key)} hitSlop={8} style={styles.trash}>
                  <Ionicons name="trash-outline" size={18} color={colors.red} />
                </Pressable>
              </View>
            );
          })
        )}
        <Button title="+ Add Link" onPress={addRow} variant="ghost" small style={{ marginTop: spacing.sm }} />
      </Card>

      {/* Notes */}
      <SectionTitle>Notes (optional)</SectionTitle>
      <Card>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Anything to add about today's work…"
          placeholderTextColor={colors.faint}
          multiline
          style={styles.notesBox}
        />
      </Card>

      <Button
        title={submittedCount ? "Update Links" : "Submit Report"}
        onPress={handleSubmit}
        loading={saving}
        disabled={liveCount === 0}
      />
      <Text style={styles.footNote}>
        Duplicates across days are removed automatically — you'll see a note here if any are skipped.
      </Text>

      {/* Account picker modal */}
      <Modal visible={pickerFor !== null} animationType="slide" transparent onRequestClose={() => setPickerFor(null)}>
        <View style={styles.modalScrim}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{pickerFor === "all" ? "Assign all links to" : "Pick account"}</Text>
            <FlatList
              data={accounts}
              keyExtractor={(a) => a.id}
              style={{ maxHeight: 380 }}
              ListHeaderComponent={
                <Pressable style={styles.accountRow} onPress={() => assignAccount(undefined)}>
                  <Text style={[styles.accountName, { color: colors.sub }]}>No account</Text>
                </Pressable>
              }
              renderItem={({ item }) => (
                <Pressable style={styles.accountRow} onPress={() => assignAccount(item.id)}>
                  <Text style={styles.accountName}>{accountLabel(item)}</Text>
                  <Text style={styles.accountHandle} numberOfLines={1}>
                    @{(item.handle || "").split("?")[0].replace(/^@/, "")}
                  </Text>
                </Pressable>
              )}
            />
            <Button title="Close" onPress={() => setPickerFor(null)} variant="ghost" small />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subTitle: { fontSize: 14, fontWeight: "700", color: colors.ink },
  subSub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  linkAction: { color: colors.purple, fontSize: 13, fontWeight: "600" },
  pasteBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    minHeight: 90,
    padding: 10,
    fontSize: 13,
    color: colors.ink,
    marginBottom: spacing.sm,
    textAlignVertical: "top",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  linkIndex: { width: 20, fontSize: 12, color: colors.faint, marginTop: 14, textAlign: "center" },
  linkInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    height: 42,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: "#fff",
  },
  accountTag: { fontSize: 11, color: colors.purple, marginTop: 4, marginLeft: 2 },
  trash: { padding: 8, marginTop: 4 },
  notesBox: { minHeight: 70, fontSize: 16, color: colors.ink, textAlignVertical: "top" },
  footNote: { fontSize: 11, color: colors.sub, textAlign: "center", marginTop: spacing.sm },
  modalScrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginBottom: 12 },
  modalTitle: { fontSize: 16, fontWeight: "700", color: colors.ink, marginBottom: 8 },
  accountRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  accountName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  accountHandle: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
