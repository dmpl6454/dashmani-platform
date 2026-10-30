import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { LayoutChangeEvent, ScrollView, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { apiFetch, describeError, fmtDay, fmtTime, rowErrors, todayIST } from "@/lib/api";
import { colors, spacing, toneColors, type } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import { Button, Card, Chips, Empty, Field, IconButton, LoadFailed, Screen, SectionTitle, invalidate } from "@/components/ui";
import { LargeTitle, ListGroup, ListItem } from "@/components/list";
import { PickerSheet } from "@/components/sheet";
import { toast } from "@/components/feedback";
import { SkeletonForm } from "@/components/skeleton";
import { haptic, readClipboardText } from "@/lib/device";
import { useDayChange } from "@/lib/hooks/shared";
import { canonicalKey } from "@/lib/canonical-url";
import {
  accountLabel,
  dedupeKey,
  detectPlatform,
  extractUrls,
  isScheduledRow,
  matchAccount,
  mergeServerRows,
  parsePriorUrls,
  platformIcon,
  priorDateOf,
  toDraftLink,
  toSubmitLink,
  toUrl,
} from "@/lib/report-links";
import type { Account, LinkRow, ServerLink } from "@/lib/report-links";

// ---------- types ----------
/** GET /hr/reports/today (null when nothing is submitted) and the POST /hr/reports answer. */
type TodayReport = {
  id?: string;
  notes?: string | null;
  submittedAt?: string | null;
  links?: ServerLink[] | null;
  dedupe?: { inSubmission?: number; crossDay?: number; total?: number } | null;
};

/** GET /hr/reports/draft?date= (null when there is no draft). */
type DraftData = {
  notes?: string | null;
  links?: Array<{ url?: string | null; accountId?: string | null }> | null;
  savedAt?: string | null;
};

type LoadState = "loading" | "ok" | "failed";
type DraftStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "failed" };
type ResultMsg = { tone: "success" | "danger"; text: string };

const AUTO = "AUTO";
const AUTOSAVE_MS = 3000;

let keySeq = 0;
const newKey = (): string => `r${++keySeq}`;

// ---------- helpers ----------
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function defaultIdOf(v: string): string | undefined {
  return v === AUTO ? undefined : v;
}

function serverLinks(r: TodayReport | null | undefined): ServerLink[] {
  return r && Array.isArray(r.links) ? r.links : [];
}

/** Live (non-scheduled, with a url) links of a server report. */
function liveServerCount(r: TodayReport | null | undefined): number {
  return serverLinks(r).filter((l) => l.isScheduled !== true && !!(l.url ?? "").trim()).length;
}

function timeMs(s: string | null | undefined): number {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function hostLabel(url: string): string {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "This";
  }
}

/** "facebook.com link on an Instagram account" */
function mismatchText(url: string, acc: Account): string {
  const platform = acc.platform || acc.platformSlug || "this";
  const article = /^[aeiou]/i.test(platform) ? "an" : "a";
  return `${hostLabel(url.trim())} link on ${article} ${platform} account`;
}

function draftRowsOf(d: DraftData | null): LinkRow[] {
  const list = d && Array.isArray(d.links) ? d.links : [];
  const out: LinkRow[] = [];
  for (const l of list) {
    if (!l || typeof l.url !== "string" || !l.url.trim()) continue;
    out.push({
      key: newKey(),
      url: l.url.trim(),
      accountId: typeof l.accountId === "string" && l.accountId ? l.accountId : undefined,
      source: "local",
    });
  }
  return out;
}

function serverRowsOf(r: TodayReport | null | undefined): LinkRow[] {
  return mergeServerRows([], serverLinks(r), newKey).rows;
}

/**
 * Prior-day marking + auto-assign (single account / unique host match / Posting-to default) +
 * platform-mismatch flag. Returns the same object when nothing changed (keeps memoised rows).
 */
function decorate(row: LinkRow, accounts: Account[], prior: Map<string, string>, defaultId?: string): LinkRow {
  if (isScheduledRow(row)) return row;
  const url = row.url.trim();
  if (!url) return row;
  const priorDate = priorDateOf(url, prior);
  let next: LinkRow = (row.priorDate ?? null) === priorDate ? row : { ...row, priorDate };
  const assigned = next.accountId;
  if (!assigned) {
    if (accounts.length > 0) {
      const m = matchAccount(url, accounts, defaultId);
      if (m.accountId) next = { ...next, accountId: m.accountId, auto: m.auto, mismatch: m.mismatch };
    }
  } else {
    const acc = accounts.find((a) => a.id === assigned);
    const mismatch = acc ? matchAccount(url, [acc]).mismatch : false;
    if (mismatch !== !!next.mismatch) next = { ...next, mismatch };
  }
  return next;
}

function decorateAll(rows: LinkRow[], accounts: Account[], prior: Map<string, string>, defaultId?: string): LinkRow[] {
  let changed = false;
  const next = rows.map((r) => {
    const d = decorate(r, accounts, prior, defaultId);
    if (d !== r) changed = true;
    return d;
  });
  return changed ? next : rows;
}

function replaceRow(rows: LinkRow[], key: string, fn: (r: LinkRow) => LinkRow): LinkRow[] {
  let changed = false;
  const next = rows.map((r) => {
    if (r.key !== key) return r;
    const n = fn(r);
    if (n !== r) changed = true;
    return n;
  });
  return changed ? next : rows;
}

/**
 * What a submit sends: trimmed, deduped by canonicalKey, prior-day rows excluded; scheduled /
 * url-less server rows are carried through untouched (never deduped).
 */
function buildSend(rows: LinkRow[]): { send: LinkRow[]; skipped: number } {
  const seen = new Set<string>();
  const send: LinkRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (isScheduledRow(r)) {
      send.push(r);
      continue;
    }
    const url = r.url.trim();
    if (!url) continue;
    if (r.priorDate) {
      skipped += 1;
      continue;
    }
    const k = canonicalKey(url);
    if (seen.has(k)) {
      skipped += 1;
      continue;
    }
    seen.add(k);
    send.push(url === r.url ? r : { ...r, url });
  }
  return { send, skipped };
}

// ---------- one link row ----------
type LinkRowProps = {
  row: LinkRow;
  index: number;
  last: boolean;
  isLastEditable: boolean;
  account?: Account;
  duplicate: boolean;
  missing: boolean;
  onChangeUrl: (key: string, url: string) => void;
  onBlurUrl: (key: string) => void;
  onPick: (key: string) => void;
  onRemove: (key: string) => void;
  onNext: (key: string) => void;
  registerInput: (key: string, node: TextInput | null) => void;
  onLayoutRow: (key: string, y: number) => void;
};

const LinkRowItem = memo(function LinkRowItem({
  row,
  index,
  last,
  isLastEditable,
  account,
  duplicate,
  missing,
  onChangeUrl,
  onBlurUrl,
  onPick,
  onRemove,
  onNext,
  registerInput,
  onLayoutRow,
}: LinkRowProps) {
  const n = index + 1;
  const onLayout = (e: LayoutChangeEvent) => onLayoutRow(row.key, e.nativeEvent.layout.y);

  if (isScheduledRow(row)) {
    const s = row.server;
    const label = account ? accountLabel(account) : s?.accountName || "Scheduled post";
    const when = s?.scheduledFor ? `Scheduled · ${fmtTime(s.scheduledFor)}` : "Scheduled";
    return (
      <View style={last ? null : styles.rowSep} onLayout={onLayout}>
        <ListItem icon="time-outline" tint="blue" title={label} subtitle={when} last />
      </View>
    );
  }

  const muted = !!row.priorDate;
  const url = row.url.trim();
  const icon = account ? platformIcon(account.platformSlug || account.platform) : null;
  const assignedTitle = account ? accountLabel(account) : row.server?.accountName || "Assigned account";

  return (
    <View style={last ? null : styles.rowSep} onLayout={onLayout}>
      <View style={[styles.rowTop, muted ? styles.muted : null]}>
        <Text style={styles.index} maxFontSizeMultiplier={1.6}>
          {n}
        </Text>
        <Field
          ref={(node) => registerInput(row.key, node)}
          value={row.url}
          onChangeText={(t) => onChangeUrl(row.key, t)}
          onBlur={() => onBlurUrl(row.key)}
          placeholder="https://…"
          keyboardType="url"
          textContentType="URL"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={isLastEditable ? "done" : "next"}
          blurOnSubmit={isLastEditable}
          onSubmitEditing={() => onNext(row.key)}
          accessibilityLabel={`Link ${n}`}
          style={styles.urlField}
        />
        <IconButton icon="close-circle" label={`Remove link ${n}`} tint={colors.faint} onPress={() => onRemove(row.key)} />
      </View>
      <View style={muted ? styles.muted : null}>
        {row.accountId && icon ? (
          <ListItem
            icon={icon.icon}
            tint={icon.tint}
            title={assignedTitle}
            detail={row.auto ? "auto" : undefined}
            chevron
            onPress={() => onPick(row.key)}
            accessibilityHint="Choose the account this link was posted on"
            last
          />
        ) : row.accountId ? (
          <ListItem
            icon="at"
            tint="gray"
            title={assignedTitle}
            chevron
            onPress={() => onPick(row.key)}
            accessibilityHint="Choose the account this link was posted on"
            last
          />
        ) : (
          <ListItem
            icon="at"
            tint="orange"
            title="Choose account"
            subtitle="Which account was this posted on?"
            chevron
            onPress={() => onPick(row.key)}
            last
          />
        )}
      </View>
      <View style={styles.messages}>
        {row.priorDate ? (
          <Text style={styles.note} maxFontSizeMultiplier={1.6}>
            {`Submitted on ${fmtDay(row.priorDate, { weekday: false })} · won't be sent again`}
          </Text>
        ) : null}
        {duplicate ? (
          <Text style={styles.note} maxFontSizeMultiplier={1.6}>
            Already in the list
          </Text>
        ) : null}
        {row.mismatch && account && url ? (
          <Text style={styles.warn} maxFontSizeMultiplier={1.6}>
            {mismatchText(url, account)}
          </Text>
        ) : null}
        {row.error ? (
          <Text style={styles.err} maxFontSizeMultiplier={1.6} accessibilityLiveRegion="polite">
            {row.error}
          </Text>
        ) : missing ? (
          <Text style={styles.err} maxFontSizeMultiplier={1.6} accessibilityLiveRegion="polite">
            Choose the account this link was posted on
          </Text>
        ) : null}
      </View>
    </View>
  );
});

// ---------- screen ----------
export default function ReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ paste?: string }>();
  const pasteParam = params.paste;

  const scrollRef = useRef<ScrollView | null>(null);
  const pasteRef = useRef<TextInput | null>(null);
  const inputRefs = useRef(new Map<string, TextInput>());
  const rowY = useRef(new Map<string, number>());
  const listY = useRef(0);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsState, setAccountsState] = useState<LoadState>("loading");
  const [todayReport, setTodayReport] = useState<TodayReport | null>(null);
  // "failed" = GET /hr/reports/today did not answer. Then we do NOT know what is already
  // submitted, and the server's delete-and-recreate could replace it — submitting is refused.
  const [todayState, setTodayState] = useState<LoadState>("loading");
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [notes, setNotes] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [defaultAccount, setDefaultAccount] = useState<string>(AUTO);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>({ kind: "idle" });
  const [result, setResult] = useState<ResultMsg | null>(null);
  const [mergeNote, setMergeNote] = useState<string | null>(null);

  // The IST day this form belongs to — frozen per load; changed only by useDayChange.
  const loadedDateRef = useRef(todayIST());
  const restoredRef = useRef(false);
  const skipNextAutosave = useRef(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittingRef = useRef(false);
  const loadSeq = useRef(0);
  const rowsRef = useRef<LinkRow[]>([]);
  const notesRef = useRef("");
  const accountsRef = useRef<Account[]>([]);
  const priorRef = useRef<Map<string, string>>(new Map());
  const defaultRef = useRef<string>(AUTO);
  const pendingFocus = useRef<string | null>(null);

  const commitRows = useCallback((next: LinkRow[]) => {
    if (next === rowsRef.current) return;
    rowsRef.current = next;
    setRows(next);
  }, []);

  const updateRows = useCallback(
    (fn: (prev: LinkRow[]) => LinkRow[]) => {
      commitRows(fn(rowsRef.current));
    },
    [commitRows],
  );

  const setNotesBoth = useCallback((n: string) => {
    notesRef.current = n;
    setNotes(n);
  }, []);

  const clearDraftTimer = useCallback(() => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
  }, []);

  // ---------- load ----------
  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      const date = loadedDateRef.current;
      const seq = ++loadSeq.current;
      if (mode === "refresh") setRefreshing(true);
      const [accs, today, draft, prior] = await Promise.allSettled([
        apiFetch<Account[]>("/hr/accounts"),
        apiFetch<TodayReport | null>("/hr/reports/today"),
        apiFetch<DraftData | null>(`/hr/reports/draft?date=${date}`),
        apiFetch<unknown>("/hr/reports/my-link-urls?days=90"),
      ]);
      // A newer load (pull, retry, day change) owns the screen now.
      if (seq !== loadSeq.current || date !== loadedDateRef.current) return;

      let accountList = accountsRef.current;
      if (accs.status === "fulfilled") {
        accountList = Array.isArray(accs.value) ? accs.value : [];
        accountsRef.current = accountList;
        setAccounts(accountList);
        setAccountsState("ok");
      } else {
        setAccountsState("failed");
      }
      if (prior.status === "fulfilled") priorRef.current = parsePriorUrls(prior.value);

      const fresh = today.status === "fulfilled" ? (today.value ?? null) : null;
      if (today.status === "fulfilled") {
        setTodayReport(fresh);
        setTodayState("ok");
      } else {
        setTodayState("failed");
      }

      let next = rowsRef.current;
      let added = 0;
      if (!restoredRef.current) {
        restoredRef.current = true;
        skipNextAutosave.current = true;
        const d = draft.status === "fulfilled" ? (draft.value ?? null) : null;
        const draftRows = draftRowsOf(d);
        // Prefer the newer of draft vs submitted snapshot (a draft survives adds after a submit).
        const draftNewer =
          draftRows.length > 0 && (!fresh?.submittedAt || timeMs(d?.savedAt) > timeMs(fresh.submittedAt));
        if (draftNewer) {
          next = draftRows;
          setNotesBoth(d?.notes ?? "");
        } else {
          next = [];
          if (fresh?.notes) setNotesBoth(fresh.notes);
        }
        if (fresh) {
          const m = mergeServerRows(next, serverLinks(fresh), newKey);
          next = m.rows;
          if (draftNewer) added = m.added;
        }
      } else if (fresh) {
        // Every fulfilled today-load folds the submitted links in (never removes a row).
        const m = mergeServerRows(next, serverLinks(fresh), newKey);
        next = m.rows;
        added = m.added;
        if (!notesRef.current.trim() && fresh.notes) setNotesBoth(fresh.notes);
      }

      next = decorateAll(next, accountList, priorRef.current, defaultIdOf(defaultRef.current));
      if (!restoredRef.current || next !== rowsRef.current) {
        rowsRef.current = next;
        setRows(next);
      }
      if (added > 0) {
        setMergeNote(`${plural(added, "link")} submitted earlier today ${added === 1 ? "is" : "are"} included`);
      }
      if (mode === "initial") setInitialLoading(false);
      setRefreshing(false);
    },
    [setNotesBoth],
  );

  const reload = useCallback(() => {
    void load("refresh");
  }, [load]);

  useEffect(() => {
    void load("initial");
  }, [load]);

  // A new IST day: start a fresh form for that day.
  const shownDate = useDayChange((today) => {
    loadedDateRef.current = today;
    loadSeq.current += 1;
    clearDraftTimer();
    restoredRef.current = false;
    skipNextAutosave.current = true;
    commitRows([]);
    setNotesBoth("");
    setTodayReport(null);
    setTodayState("loading");
    setResult(null);
    setMergeNote(null);
    setAttempted(false);
    setDraftStatus({ kind: "idle" });
    setPasteText("");
    setPickerFor(null);
    setInitialLoading(true);
    void load("initial");
  });

  // ---------- autosave (3 s debounce) ----------
  useEffect(() => {
    if (!restoredRef.current) return;
    if (skipNextAutosave.current) {
      skipNextAutosave.current = false;
      return;
    }
    if (submittingRef.current) return;
    const date = loadedDateRef.current;
    clearDraftTimer();
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      if (date !== loadedDateRef.current || submittingRef.current) return;
      const byId = new Map(accountsRef.current.map((a) => [a.id, a] as const));
      const links = rowsRef.current
        .filter((r) => !isScheduledRow(r) && r.url.trim())
        .map((r) => toDraftLink(r, byId));
      setDraftStatus({ kind: "saving" });
      apiFetch<{ savedAt?: string | null } | null>("/hr/reports/draft", {
        method: "PUT",
        body: JSON.stringify({ date, notes: notesRef.current, links }),
      })
        .then((res) => {
          if (date !== loadedDateRef.current) return;
          setDraftStatus({ kind: "saved", at: res?.savedAt || new Date().toISOString() });
        })
        .catch(() => {
          if (date !== loadedDateRef.current) return;
          setDraftStatus({ kind: "failed" });
        });
    }, AUTOSAVE_MS);
    return clearDraftTimer;
  }, [rows, notes, clearDraftTimer]);

  // Focus a just-added row once its input is mounted.
  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    const node = inputRefs.current.get(k);
    if (node) {
      pendingFocus.current = null;
      node.focus();
    }
  }, [rows]);

  // The result card sits directly above the submit bar: bring it into view.
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [result]);

  const scrollToRow = useCallback((key: string) => {
    const y = rowY.current.get(key);
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, listY.current + y - spacing.xxl * 2), animated: true });
  }, []);

  // ---------- adding links ----------
  const addUrls = useCallback(
    (urls: string[], skippedLines: number) => {
      const current = rowsRef.current;
      const seen = new Set<string>();
      current.forEach((r) => {
        const k = dedupeKey(r);
        if (k) seen.add(k);
      });
      const accs = accountsRef.current;
      const def = defaultIdOf(defaultRef.current);
      const fresh: LinkRow[] = [];
      let dups = 0;
      let earlier = 0;
      urls.forEach((u) => {
        const k = canonicalKey(u);
        if (seen.has(k)) {
          dups += 1;
          return;
        }
        seen.add(k);
        const row = decorate({ key: newKey(), url: u, source: "local" }, accs, priorRef.current, def);
        if (row.priorDate) earlier += 1;
        fresh.push(row);
      });
      if (fresh.length > 0) {
        // Blank local rows were placeholders for exactly these links.
        const kept = current.filter((r) => !!r.server || !!r.url.trim());
        commitRows([...kept, ...fresh]);
      }
      const parts = [`${plural(fresh.length, "link")} added`];
      if (dups > 0) parts.push(`${plural(dups, "duplicate")} skipped`);
      if (skippedLines > 0) parts.push(`${plural(skippedLines, "line")} skipped`);
      if (earlier > 0) parts.push(`${earlier} submitted on an earlier day`);
      toast.show({ message: parts.join(" · "), tone: fresh.length > 0 ? "success" : "warning" });
      void haptic(fresh.length > 0 ? "success" : "warning");
      setResult(null);
    },
    [commitRows],
  );

  const focusPasteBox = useCallback(() => {
    setPasteOpen(true);
    setTimeout(() => pasteRef.current?.focus(), 50);
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    const text = await readClipboardText();
    const parsed = text ? extractUrls(text) : { urls: [], skippedLines: 0 };
    if (parsed.urls.length === 0) {
      toast.show({ message: "Nothing to paste — paste into the box below", tone: "warning" });
      focusPasteBox();
      return;
    }
    addUrls(parsed.urls, parsed.skippedLines);
  }, [addUrls, focusPasteBox]);

  // ?paste=1 (from Home): read the clipboard once, after the first load settled.
  useEffect(() => {
    if (pasteParam !== "1" || initialLoading) return;
    router.setParams({ paste: "" });
    if (Platform.OS === "web") focusPasteBox();
    else void pasteFromClipboard();
  }, [pasteParam, initialLoading, router, focusPasteBox, pasteFromClipboard]);

  const parsedPaste = useMemo(() => extractUrls(pasteText), [pasteText]);

  const addFromBox = useCallback(() => {
    if (parsedPaste.urls.length === 0) return;
    addUrls(parsedPaste.urls, parsedPaste.skippedLines);
    setPasteText("");
    setPasteOpen(false);
  }, [addUrls, parsedPaste]);

  const addRow = useCallback(() => {
    const key = newKey();
    const m = matchAccount("", accountsRef.current, defaultIdOf(defaultRef.current));
    pendingFocus.current = key;
    updateRows((prev) => [...prev, { key, url: "", source: "local", accountId: m.accountId, auto: m.auto }]);
  }, [updateRows]);

  // ---------- row callbacks (stable, keyed by row.key) ----------
  const onChangeUrl = useCallback(
    (key: string, url: string) => {
      updateRows((prev) => replaceRow(prev, key, (r) => ({ ...r, url, error: undefined })));
    },
    [updateRows],
  );

  const onBlurUrl = useCallback(
    (key: string) => {
      updateRows((prev) =>
        replaceRow(prev, key, (r) => {
          const trimmed = r.url.trim();
          const url = trimmed ? (toUrl(trimmed) ?? trimmed) : "";
          const base = url === r.url ? r : { ...r, url };
          return decorate(base, accountsRef.current, priorRef.current, defaultIdOf(defaultRef.current));
        }),
      );
    },
    [updateRows],
  );

  const onPick = useCallback((key: string) => setPickerFor(key), []);

  const onRemove = useCallback(
    (key: string) => {
      inputRefs.current.delete(key);
      rowY.current.delete(key);
      updateRows((prev) => prev.filter((r) => r.key !== key));
    },
    [updateRows],
  );

  const onNext = useCallback((key: string) => {
    const editable = rowsRef.current.filter((r) => !isScheduledRow(r));
    const i = editable.findIndex((r) => r.key === key);
    const nxt = i >= 0 ? editable[i + 1] : undefined;
    if (nxt) inputRefs.current.get(nxt.key)?.focus();
    else inputRefs.current.get(key)?.blur();
  }, []);

  const registerInput = useCallback((key: string, node: TextInput | null) => {
    if (node) inputRefs.current.set(key, node);
    else inputRefs.current.delete(key);
  }, []);

  const onLayoutRow = useCallback((key: string, y: number) => {
    rowY.current.set(key, y);
  }, []);

  const onSelectAccount = useCallback(
    (a: Account) => {
      const key = pickerFor;
      if (!key) return;
      updateRows((prev) =>
        replaceRow(prev, key, (r) => ({
          ...r,
          accountId: a.id,
          auto: undefined,
          mismatch: r.url.trim() ? matchAccount(r.url, [a]).mismatch : false,
          error: undefined,
        })),
      );
      void haptic("selection");
    },
    [pickerFor, updateRows],
  );

  // ---------- submit ----------
  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    const date = loadedDateRef.current;
    setResult(null);

    const first = buildSend(rowsRef.current);
    const live = first.send.filter((r) => !isScheduledRow(r));
    if (live.length === 0) {
      setResult({ tone: "danger", text: "Add at least one link before submitting" });
      void haptic("warning");
      return;
    }
    const missingFirst = live.find((r) => !r.accountId);
    if (missingFirst) {
      setAttempted(true);
      void haptic("warning");
      scrollToRow(missingFirst.key);
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    clearDraftTimer();
    let sent: LinkRow[] = [];
    try {
      let fresh: TodayReport | null;
      try {
        fresh = await apiFetch<TodayReport | null>("/hr/reports/today");
      } catch {
        setTodayState("failed");
        setResult({ tone: "danger", text: "Couldn't check what's already submitted — nothing was changed" });
        void haptic("error");
        return;
      }
      if (date !== loadedDateRef.current) return;
      setTodayReport(fresh ?? null);
      setTodayState("ok");
      const merged = mergeServerRows(rowsRef.current, serverLinks(fresh), newKey);
      if (merged.added > 0) {
        commitRows(decorateAll(merged.rows, accountsRef.current, priorRef.current, defaultIdOf(defaultRef.current)));
        setMergeNote(
          `${plural(merged.added, "link")} submitted earlier today ${merged.added === 1 ? "is" : "are"} included`,
        );
      }

      const { send, skipped } = buildSend(rowsRef.current);
      const missing = send.find((r) => !isScheduledRow(r) && !r.accountId);
      if (missing) {
        setAttempted(true);
        void haptic("warning");
        scrollToRow(missing.key);
        return;
      }
      sent = send;
      const byId = new Map(accountsRef.current.map((a) => [a.id, a] as const));
      const report = await apiFetch<TodayReport>("/hr/reports", {
        method: "POST",
        body: JSON.stringify({ date, notes: notesRef.current.trim(), links: send.map((r) => toSubmitLink(r, byId)) }),
      });
      // Clear the draft for the SAME date we just posted.
      apiFetch(`/hr/reports/draft?date=${date}`, { method: "DELETE" }).catch(() => undefined);
      clearDraftTimer();
      skipNextAutosave.current = true;
      commitRows(serverRowsOf(report));
      setTodayReport(report);
      setTodayState("ok");
      setAttempted(false);
      setMergeNote(null);
      setDraftStatus({ kind: "idle" });
      setPasteOpen(false);

      const saved = liveServerCount(report);
      const serverSkipped = typeof report?.dedupe?.total === "number" ? report.dedupe.total : 0;
      const dup = serverSkipped + skipped;
      setResult({
        tone: "success",
        text: `${plural(saved, "link")} saved${dup > 0 ? ` · ${plural(dup, "duplicate")} skipped — no links were lost` : ""}`,
      });
      invalidate("report");
      void haptic("success");
      toast.show({ message: "Report submitted", tone: "success" });
    } catch (e: unknown) {
      const byIndex = rowErrors(e, "links");
      const keyed = new Map<string, string>();
      Object.keys(byIndex).forEach((k) => {
        const idx = Number(k);
        const row = sent[idx];
        if (row) keyed.set(row.key, byIndex[idx]);
      });
      if (keyed.size > 0) {
        updateRows((prev) =>
          prev.map((r) => {
            const msg = keyed.get(r.key);
            if (msg !== undefined) return { ...r, error: msg };
            return r.error ? { ...r, error: undefined } : r;
          }),
        );
        const firstKey = sent.find((r) => keyed.has(r.key))?.key;
        if (firstKey) scrollToRow(firstKey);
      }
      setResult({ tone: "danger", text: describeError(e, "Submit failed") });
      void haptic("error");
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }, [clearDraftTimer, commitRows, scrollToRow, updateRows]);

  // ---------- derived ----------
  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a] as const)), [accounts]);

  const derived = useMemo(() => {
    const seen = new Set<string>();
    const dupRows = new Set<string>();
    const missing: string[] = [];
    let live = 0;
    let lastEditable: string | null = null;
    for (const r of rows) {
      if (isScheduledRow(r)) continue;
      lastEditable = r.key;
      const k = dedupeKey(r);
      if (!k) continue;
      if (seen.has(k)) {
        dupRows.add(r.key);
        continue;
      }
      seen.add(k);
      if (r.priorDate) continue;
      live += 1;
      if (!r.accountId) missing.push(r.key);
    }
    return { dupRows, missing, live, lastEditable };
  }, [rows]);

  const chipOptions = useMemo(() => [AUTO, ...accounts.map((a) => a.id)], [accounts]);
  const chipLabels = useMemo(() => {
    const out: Partial<Record<string, string>> = { [AUTO]: "Auto" };
    accounts.forEach((a) => {
      out[a.id] = a.displayName || accountLabel(a);
    });
    return out;
  }, [accounts]);
  const chipValue = accounts.some((a) => a.id === defaultAccount) ? defaultAccount : AUTO;

  const pickRow = pickerFor ? rows.find((r) => r.key === pickerFor) : undefined;
  const pickUrl = pickRow ? pickRow.url.trim() : "";
  const pickerGroups =
    pickUrl && detectPlatform(pickUrl)
      ? [
          {
            title: "Matches this link",
            match: (a: Account) => !!(a.platformSlug || a.platform) && !matchAccount(pickUrl, [a]).mismatch,
          },
        ]
      : undefined;

  const submittedCount = liveServerCount(todayReport);

  const title = (
    <LargeTitle
      title="Daily Report"
      subtitle={fmtDay(shownDate, { weekday: true })}
      right={<IconButton icon="time-outline" label="Report history" onPress={() => router.push("/history")} />}
    />
  );

  if (initialLoading) {
    return (
      <Screen header="none">
        {title}
        <SkeletonForm fields={4} />
      </Screen>
    );
  }

  // ---------- day card ----------
  let dayCard: React.ReactNode;
  if (todayState === "failed") {
    dayCard = (
      <Card style={styles.block}>
        <View style={styles.dayRow}>
          <Ionicons name="cloud-offline-outline" size={24} color={colors.sub} />
          <View style={styles.flex}>
            <Text style={styles.dayTitle} maxFontSizeMultiplier={1.6}>
              {"Couldn't check today's report"}
            </Text>
            <Text style={styles.daySub} maxFontSizeMultiplier={1.6}>
              Your submitted links are safe. Retry before submitting.
            </Text>
          </View>
        </View>
        <Button
          variant="plain"
          size="md"
          title="Retry"
          onPress={reload}
          loading={refreshing}
          fullWidth={false}
          style={styles.dayAction}
        />
      </Card>
    );
  } else {
    const tone: Tone = submittedCount > 0 ? "success" : "warning";
    const t = toneColors(tone);
    dayCard = (
      <Card variant="tinted" tone={tone} style={styles.block}>
        <View style={styles.dayRow}>
          <Ionicons name={submittedCount > 0 ? "checkmark-circle" : "time-outline"} size={24} color={t.fg} />
          <View style={styles.flex}>
            <Text style={[styles.dayTitle, { color: t.text }]} maxFontSizeMultiplier={1.6}>
              {submittedCount > 0 ? `Submitted today · ${plural(submittedCount, "link")}` : "Nothing submitted yet today"}
            </Text>
            {submittedCount > 0 && todayReport?.submittedAt ? (
              <Text style={styles.daySub} maxFontSizeMultiplier={1.6}>
                {`Last submitted ${fmtTime(todayReport.submittedAt)}`}
              </Text>
            ) : null}
          </View>
        </View>
      </Card>
    );
  }

  const draftLine =
    draftStatus.kind === "saving"
      ? "Saving draft…"
      : draftStatus.kind === "saved"
        ? `Draft saved ${fmtTime(draftStatus.at)}`
        : draftStatus.kind === "failed"
          ? "Draft not saved — check your connection"
          : null;

  // ---------- paste ----------
  const showPaste = rows.length === 0 || pasteOpen;
  const pasteCount = parsedPaste.urls.length;
  const pasteCaption = pasteText.trim()
    ? `${plural(pasteCount, "link")} detected${
        parsedPaste.skippedLines > 0 ? ` · ${plural(parsedPaste.skippedLines, "line")} skipped` : ""
      }`
    : undefined;

  // ---------- footer ----------
  const missingCount = derived.missing.length;
  const blockedReason =
    todayState === "failed"
      ? "Can't submit — couldn't check today's report"
      : missingCount > 0
        ? `${plural(missingCount, "link")} need${missingCount === 1 ? "s" : ""} an account`
        : null;
  const onReasonPress = () => {
    if (todayState === "failed") {
      reload();
      return;
    }
    const firstMissing = derived.missing[0];
    if (firstMissing) {
      setAttempted(true);
      scrollToRow(firstMissing);
    }
  };
  const n = derived.live;
  const submitTitle =
    submittedCount > 0 ? `Update · ${plural(n, "link")}` : n > 0 ? `Submit ${plural(n, "link")}` : "Submit links";

  const footer = (
    <View style={styles.footer}>
      {blockedReason ? (
        <Pressable onPress={onReasonPress} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.reason} maxFontSizeMultiplier={1.6}>
            {blockedReason}
          </Text>
        </Pressable>
      ) : null}
      <Button
        variant="primary"
        title={submitTitle}
        onPress={submit}
        loading={saving}
        disabled={n === 0 || todayState !== "ok"}
      />
      <Text style={styles.caption} maxFontSizeMultiplier={1.6}>
        Duplicates across days are skipped automatically
      </Text>
    </View>
  );

  return (
    <Screen header="none" scrollRef={scrollRef} onRefresh={() => load("refresh")} refreshing={refreshing} footer={footer}>
      {title}
      {dayCard}
      {draftLine ? (
        <Text style={styles.draftLine} maxFontSizeMultiplier={1.6}>
          {draftLine}
        </Text>
      ) : null}

      {showPaste ? (
        <Card style={styles.block}>
          <Button
            variant="primary"
            size="md"
            title="Paste links from clipboard"
            icon="clipboard-outline"
            onPress={pasteFromClipboard}
          />
          <Field
            ref={pasteRef}
            value={pasteText}
            onChangeText={setPasteText}
            multiline
            keyboardType="url"
            autoCorrect={false}
            placeholder="…or paste text here"
            accessibilityLabel="Paste links"
            hint={pasteCaption}
            style={styles.pasteField}
          />
          <Button
            variant="tinted"
            size="md"
            title={pasteCount > 0 ? `Add ${plural(pasteCount, "link")}` : "Add links"}
            disabled={pasteCount === 0}
            onPress={addFromBox}
          />
          {rows.length > 0 ? (
            <Button
              variant="plain"
              size="sm"
              title="Hide"
              onPress={() => setPasteOpen(false)}
              fullWidth={false}
              style={styles.hide}
            />
          ) : null}
        </Card>
      ) : (
        <Button
          variant="plain"
          size="md"
          icon="clipboard-outline"
          title="Paste more"
          onPress={() => setPasteOpen(true)}
          fullWidth={false}
          style={styles.inlineAction}
        />
      )}

      <SectionTitle>{`Links (${n})`}</SectionTitle>
      {mergeNote ? (
        <Text style={styles.info} maxFontSizeMultiplier={1.6}>
          {mergeNote}
        </Text>
      ) : null}
      {accounts.length > 1 ? (
        <View style={styles.postingTo}>
          <Text style={styles.postingLabel} maxFontSizeMultiplier={1.6}>
            Posting to
          </Text>
          <Chips
            mode="pills"
            options={chipOptions}
            value={chipValue}
            labels={chipLabels}
            accessibilityLabel="Default account for new links"
            onChange={(v) => {
              defaultRef.current = v;
              setDefaultAccount(v);
              void haptic("selection");
            }}
          />
        </View>
      ) : null}
      {accountsState === "failed" ? <LoadFailed compact error="Accounts didn't load" onRetry={reload} /> : null}

      {rows.length === 0 ? (
        <Empty icon="link-outline" title="No links yet" text="Paste the links you posted today" compact />
      ) : (
        <View
          onLayout={(e) => {
            listY.current = e.nativeEvent.layout.y;
          }}
        >
          <ListGroup>
            {rows.map((r, i) => (
              <LinkRowItem
                key={r.key}
                row={r}
                index={i}
                last={i === rows.length - 1}
                isLastEditable={r.key === derived.lastEditable}
                account={r.accountId ? accountsById.get(r.accountId) : undefined}
                duplicate={derived.dupRows.has(r.key)}
                missing={
                  attempted && !r.accountId && !r.priorDate && !!r.url.trim() && !derived.dupRows.has(r.key)
                }
                onChangeUrl={onChangeUrl}
                onBlurUrl={onBlurUrl}
                onPick={onPick}
                onRemove={onRemove}
                onNext={onNext}
                registerInput={registerInput}
                onLayoutRow={onLayoutRow}
              />
            ))}
          </ListGroup>
        </View>
      )}
      <Button
        variant="plain"
        size="md"
        icon="add-circle-outline"
        title="Add link"
        onPress={addRow}
        fullWidth={false}
        style={styles.inlineAction}
      />

      <SectionTitle>Notes</SectionTitle>
      <Field
        value={notes}
        onChangeText={setNotesBoth}
        multiline
        autoCapitalize="sentences"
        placeholder="Anything to add about today's work…"
        accessibilityLabel="Notes"
        trailing={
          notes ? (
            <IconButton icon="close-circle" label="Clear notes" tint={colors.faint} onPress={() => setNotesBoth("")} />
          ) : undefined
        }
      />

      {result ? (
        <Card variant="tinted" tone={result.tone} style={styles.block}>
          <View style={styles.resultRow} accessibilityLiveRegion="polite">
            <Ionicons
              name={result.tone === "success" ? "checkmark-circle" : "alert-circle"}
              size={22}
              color={toneColors(result.tone).fg}
            />
            <Text style={styles.resultText} maxFontSizeMultiplier={1.6}>
              {result.text}
            </Text>
          </View>
          <Button
            variant="plain"
            size="sm"
            title="Dismiss"
            onPress={() => setResult(null)}
            fullWidth={false}
            style={styles.dayAction}
          />
        </Card>
      ) : null}

      <PickerSheet<Account>
        visible={pickerFor !== null && !!pickRow}
        onClose={() => setPickerFor(null)}
        title="Posted on"
        items={accounts}
        keyOf={(a) => a.id}
        labelOf={(a) => accountLabel(a)}
        subtitleOf={(a) => {
          const handle = (a.handle || "").split("?")[0].replace(/^@/, "");
          const parts = [handle ? `@${handle}` : "", a.clientName || ""].filter((s) => !!s);
          return parts.length > 0 ? parts.join(" · ") : undefined;
        }}
        iconOf={(a) => platformIcon(a.platformSlug || a.platform).icon}
        tintOf={(a) => platformIcon(a.platformSlug || a.platform).tint}
        selectedKey={pickRow?.accountId ?? null}
        onSelect={onSelectAccount}
        searchable={accounts.length > 8}
        groups={pickerGroups}
        loading={accountsState === "loading"}
        error={accountsState === "failed" ? "Accounts didn't load" : null}
        onRetry={reload}
        emptyText="No accounts are assigned to you yet"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  block: { marginBottom: spacing.md },
  dayRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  dayTitle: { ...type.headline, color: colors.ink },
  daySub: { ...type.footnote, color: colors.sub, marginTop: 2 },
  dayAction: { marginTop: spacing.sm, alignSelf: "flex-start" },
  draftLine: { ...type.footnote, color: colors.tertiary, marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  pasteField: { marginTop: spacing.md, marginBottom: spacing.sm },
  hide: { marginTop: spacing.xs, alignSelf: "center" },
  inlineAction: { alignSelf: "flex-start", marginBottom: spacing.md },
  info: { ...type.footnote, color: colors.sub, marginBottom: spacing.sm },
  postingTo: { marginBottom: spacing.md },
  postingLabel: { ...type.footnote, color: colors.sub, marginBottom: spacing.xs },
  rowSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingTop: spacing.md,
  },
  index: { ...type.footnote, ...type.numeric, color: colors.tertiary, width: 22 },
  urlField: { flex: 1, marginBottom: 0 },
  muted: { opacity: 0.5 },
  messages: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 2 },
  note: { ...type.footnote, color: colors.sub },
  warn: { ...type.footnote, color: colors.warningText },
  err: { ...type.footnote, color: colors.redText },
  resultRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  resultText: { ...type.subhead, color: colors.ink, flex: 1 },
  footer: { gap: spacing.sm },
  reason: { ...type.footnote, color: colors.warningText, textAlign: "center" },
  caption: { ...type.caption, color: colors.sub, textAlign: "center" },
});
