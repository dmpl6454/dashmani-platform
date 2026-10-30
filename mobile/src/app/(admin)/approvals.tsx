import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { API_BASE, ApiError, apiFetch, describeError, fmtDate, fmtDateTime, fmtDay, fmtMoney, fmtRange } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { haptic, openFile } from "@/lib/device";
import { invalidatePendingCounts, usePendingCounts, type PendingCounts } from "@/lib/hooks/shared";
import { Avatar, Button, Card, Chips, ErrorBanner, Screen, useApi, type IoniconName } from "@/components/ui";
import { LargeTitle, ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { confirm, toast, type ConfirmOptions } from "@/components/feedback";

const TABS = ["LEAVES", "EXPENSES", "EXTRA_HOURS", "NEW_EMPLOYEES", "DOCUMENTS", "JOINING"] as const;
type Tab = (typeof TABS)[number];
type CountKey = keyof Omit<PendingCounts, "total" | "status">;

const LABELS: Record<Tab, string> = {
  LEAVES: "Leaves",
  EXPENSES: "Expenses",
  EXTRA_HOURS: "Extra Hrs",
  NEW_EMPLOYEES: "New Joiners",
  DOCUMENTS: "Documents",
  JOINING: "Join Dates",
};

const QUEUE_NAME: Record<Tab, string> = {
  LEAVES: "Leaves",
  EXPENSES: "Expenses",
  EXTRA_HOURS: "Extra hours",
  NEW_EMPLOYEES: "New joiners",
  DOCUMENTS: "Documents",
  JOINING: "Join dates",
};

// Joining dates are deliberately uncounted (usePendingCounts never fetches them).
const COUNT_KEY: Record<Tab, CountKey | null> = {
  LEAVES: "leaves",
  EXPENSES: "expenses",
  EXTRA_HOURS: "extraHours",
  NEW_EMPLOYEES: "newEmployees",
  DOCUMENTS: "documents",
  JOINING: null,
};

/** Queues where the API refuses a self-review, and what the card says instead of the buttons. */
const OWN_NOTE: Partial<Record<Tab, string>> = {
  LEAVES: "Your own request — another admin must approve it",
  DOCUMENTS: "Your own document — another admin must review it",
};

const TAB_ALIASES: Record<string, Tab> = {
  LEAVE: "LEAVES",
  EXPENSE: "EXPENSES",
  EXTRAHOURS: "EXTRA_HOURS",
  HOURS: "EXTRA_HOURS",
  EMPLOYEES: "NEW_EMPLOYEES",
  JOINERS: "NEW_EMPLOYEES",
  NEW_JOINERS: "NEW_EMPLOYEES",
  DOCS: "DOCUMENTS",
  DOCUMENT: "DOCUMENTS",
  JOINING_DATES: "JOINING",
  JOIN_DATES: "JOINING",
};

const UNDO = "This can't be undone.";
const POST: RequestInit = { method: "POST" };
const PUT: RequestInit = { method: "PUT" };
const ALREADY_HANDLED = "Already reviewed elsewhere — list refreshed";

type Person = { id?: string | null; name?: string | null; email?: string | null };

type ApprovalItem = {
  id?: string;
  employeeId?: string | null;
  userId?: string | null;
  type?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  reason?: string | null;
  title?: string | null;
  category?: string | null;
  amount?: number | null;
  description?: string | null;
  receiptUrl?: string | null;
  hours?: number | null;
  date?: string | null;
  fileName?: string | null;
  filePath?: string | null;
  documentType?: string | null;
  createdAt?: string | null;
  joiningDate?: string | null;
  joiningDateApproved?: boolean | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  employee?: Person | null;
  user?: Person | null;
};

type ActionSpec = { confirm: ConfirmOptions; call: () => Promise<unknown>; done: string };
type ItemActions = { approve: ActionSpec; reject: ActionSpec | null };

type CardDetails = {
  subtitle?: string;
  detail?: string;
  line?: string;
  reason?: string;
  meta?: string;
  link?: { icon: IoniconName; title: string; subtitle?: string; url: string };
};

/** The bulk-review answer says the document was already reviewed (or not found). */
class AlreadyReviewedError extends Error {
  constructor() {
    super(ALREADY_HANDLED);
    this.name = "AlreadyReviewedError";
  }
}

/** The server says the item is no longer pending (someone else, or an earlier tap, already handled it). */
function isAlreadyHandled(e: unknown): boolean {
  if (e instanceof AlreadyReviewedError) return true;
  if (e instanceof ApiError) {
    if (e.code === "ALREADY_PROCESSED" || e.code === "ALREADY_REVIEWED") return true;
    return e.status === 409;
  }
  return false;
}

function parseTab(raw: string | string[] | undefined): Tab | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const norm = v.trim().toUpperCase().replace(/[-\s]+/g, "_");
  return TABS.find((t) => t === norm) ?? TAB_ALIASES[norm] ?? null;
}

function firstWaiting(c: PendingCounts): Tab {
  for (const t of TABS) {
    const key = COUNT_KEY[t];
    if (key && (c[key] ?? 0) > 0) return t;
  }
  return "LEAVES";
}

const LIST_KEYS = ["items", "data", "rows", "requests", "documents", "employees"];

/** A list answer as an array (bare array, or an object wrapping one). */
function listOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    for (const key of LIST_KEYS) {
      const x = rec[key];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

async function fetchQueue(tab: Tab): Promise<ApprovalItem[]> {
  switch (tab) {
    case "LEAVES":
      return listOf<ApprovalItem>(await apiFetch<unknown>("/admin/leave-requests?status=PENDING"));
    case "EXPENSES":
      return listOf<ApprovalItem>(await apiFetch<unknown>("/admin/expenses?status=PENDING"));
    case "EXTRA_HOURS":
      return listOf<ApprovalItem>(await apiFetch<unknown>("/admin/extra-hours/pending"));
    case "DOCUMENTS":
      return listOf<ApprovalItem>(await apiFetch<unknown>("/admin/documents/pending"));
    case "JOINING": {
      const rows = listOf<ApprovalItem>(await apiFetch<unknown>("/admin/joining-dates"));
      return rows.filter((r) => !r.joiningDateApproved);
    }
    case "NEW_EMPLOYEES":
      return listOf<ApprovalItem>(await apiFetch<unknown>("/admin/employees/pending"));
  }
}

async function reviewDocument(id: string, action: "APPROVE" | "REJECT"): Promise<void> {
  const r = await apiFetch<{ succeeded?: number; failed?: number } | null>("/admin/documents/bulk-review", {
    method: "POST",
    body: JSON.stringify({ ids: [id], action }),
  });
  if ((r?.failed ?? 0) > 0 || (r?.succeeded ?? 0) === 0) throw new AlreadyReviewedError();
}

function keyOf(item: ApprovalItem): string {
  return item.id ?? item.userId ?? item.user?.id ?? "";
}

function busyKeyOf(tab: Tab, item: ApprovalItem): string {
  return `${tab}:${keyOf(item)}`;
}

function whoOf(tab: Tab, item: ApprovalItem): string {
  if (tab === "JOINING") return item.user?.name || "Employee";
  if (tab === "NEW_EMPLOYEES") return item.name || "New joiner";
  return item.employee?.name || "Employee";
}

function leaveLabel(item: ApprovalItem): string {
  const label = formatStatus(item.type || "LEAVE");
  return /leave$/i.test(label) ? label : `${label} leave`;
}

function fileUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

function detailsOf(tab: Tab, item: ApprovalItem): CardDetails {
  switch (tab) {
    case "LEAVES":
      return {
        subtitle: leaveLabel(item),
        detail: item.startDate ? fmtRange(item.startDate, item.endDate) : undefined,
        reason: item.reason || undefined,
        meta: item.createdAt ? `Requested ${fmtDateTime(item.createdAt)}` : undefined,
      };
    case "EXPENSES":
      return {
        subtitle: formatStatus(item.category || "OTHER"),
        detail: fmtMoney(item.amount),
        line: item.title || undefined,
        reason: item.description || undefined,
        meta: item.createdAt ? `Filed ${fmtDateTime(item.createdAt)}` : undefined,
        link:
          typeof item.receiptUrl === "string" && item.receiptUrl.trim()
            ? { icon: "receipt-outline", title: "View receipt", url: item.receiptUrl.trim() }
            : undefined,
      };
    case "EXTRA_HOURS":
      return {
        subtitle: "Extra hours",
        detail: typeof item.hours === "number" ? `${item.hours}h` : undefined,
        line: item.date ? fmtDay(item.date, { weekday: true }) : undefined,
        reason: item.description || undefined,
        meta: item.createdAt ? `Logged ${fmtDateTime(item.createdAt)}` : undefined,
      };
    case "NEW_EMPLOYEES":
      return {
        subtitle: item.email || item.phone || "New joiner",
        meta: item.createdAt ? `Registered ${fmtDate(item.createdAt)}` : undefined,
      };
    case "DOCUMENTS":
      return {
        subtitle: formatStatus(item.documentType || "DOCUMENT"),
        meta: item.createdAt ? `Uploaded ${fmtDateTime(item.createdAt)}` : undefined,
        link:
          typeof item.filePath === "string" && item.filePath.trim()
            ? {
                icon: "document-outline",
                title: item.fileName || "Document",
                subtitle: "View document",
                url: item.filePath.trim(),
              }
            : undefined,
      };
    case "JOINING":
      return {
        subtitle: item.user?.email || undefined,
        detail: item.joiningDate ? fmtDay(item.joiningDate, { weekday: false, year: true }) : undefined,
        line: "Joining date awaiting approval",
      };
  }
}

function actionsFor(tab: Tab, item: ApprovalItem): ItemActions {
  const who = whoOf(tab, item);
  const id = item.id ?? "";
  switch (tab) {
    case "LEAVES": {
      const what = `${leaveLabel(item)}${item.startDate ? ` · ${fmtRange(item.startDate, item.endDate)}` : ""}`;
      return {
        approve: {
          confirm: { title: `Approve ${what} for ${who}?`, message: UNDO, confirmLabel: "Approve" },
          call: () => apiFetch(`/admin/leave-requests/${id}/approve`, POST),
          done: "Leave approved",
        },
        reject: {
          confirm: { title: `Reject ${what} for ${who}?`, message: UNDO, confirmLabel: "Reject", destructive: true },
          call: () => apiFetch(`/admin/leave-requests/${id}/reject`, POST),
          done: "Leave rejected",
        },
      };
    }
    case "EXPENSES": {
      const what = `${fmtMoney(item.amount)}${item.title ? ` · ${item.title}` : ""}`;
      return {
        approve: {
          confirm: { title: `Approve ${what} for ${who}?`, message: UNDO, confirmLabel: "Approve" },
          call: () => apiFetch(`/admin/expenses/${id}/approve`, POST),
          done: "Expense approved",
        },
        reject: {
          confirm: { title: `Reject ${what} for ${who}?`, message: UNDO, confirmLabel: "Reject", destructive: true },
          call: () => apiFetch(`/admin/expenses/${id}/reject`, POST),
          done: "Expense rejected",
        },
      };
    }
    case "EXTRA_HOURS": {
      const hours = typeof item.hours === "number" ? `${item.hours}h` : "extra hours";
      const what = `${hours}${item.date ? ` · ${fmtDay(item.date, { weekday: false })}` : ""}`;
      return {
        approve: {
          confirm: { title: `Approve ${what} for ${who}?`, message: UNDO, confirmLabel: "Approve" },
          call: () => apiFetch(`/admin/extra-hours/${id}/approve`, POST),
          done: "Hours approved",
        },
        reject: {
          confirm: { title: `Reject ${what} for ${who}?`, message: UNDO, confirmLabel: "Reject", destructive: true },
          call: () => apiFetch(`/admin/extra-hours/${id}/reject`, POST),
          done: "Hours rejected",
        },
      };
    }
    case "DOCUMENTS": {
      const what = item.fileName ? `“${item.fileName}”` : "this document";
      return {
        approve: {
          confirm: { title: `Approve ${what} from ${who}?`, message: UNDO, confirmLabel: "Approve" },
          call: () => reviewDocument(id, "APPROVE"),
          done: "Document approved",
        },
        reject: {
          confirm: { title: `Reject ${what} from ${who}?`, message: UNDO, confirmLabel: "Reject", destructive: true },
          call: () => reviewDocument(id, "REJECT"),
          done: "Document rejected",
        },
      };
    }
    case "JOINING": {
      const date = item.joiningDate ? ` ${fmtDay(item.joiningDate, { weekday: false, year: true })}` : "";
      return {
        approve: {
          confirm: { title: `Approve joining date${date} for ${who}?`, message: UNDO, confirmLabel: "Approve" },
          call: () => apiFetch(`/admin/joining-dates/${item.user?.id ?? item.userId}/approve`, POST),
          done: "Joining date approved",
        },
        reject: null,
      };
    }
    case "NEW_EMPLOYEES":
      return {
        approve: {
          confirm: { title: `Approve ${who}'s registration?`, message: UNDO, confirmLabel: "Approve" },
          call: () => apiFetch(`/admin/employees/${id}/approve`, PUT),
          done: "Employee approved",
        },
        reject: {
          confirm: {
            title: `Reject ${who}'s registration?`,
            message: UNDO,
            confirmLabel: "Reject",
            destructive: true,
          },
          call: () => apiFetch(`/admin/employees/${id}/reject`, PUT),
          done: "Registration rejected",
        },
      };
  }
}

/** Put a removed item back where it was (no-op when it is already there). */
function restore(prev: ApprovalItem[] | null, item: ApprovalItem, index: number): ApprovalItem[] {
  const cur = prev ?? [];
  const key = keyOf(item);
  if (cur.some((i) => keyOf(i) === key)) return cur;
  const next = cur.slice();
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next;
}

/** The note shown instead of the buttons when the signed-in admin filed this item themself. */
function ownNoteFor(tab: Tab, item: ApprovalItem, userId: string | undefined): string | null {
  const note = OWN_NOTE[tab];
  if (!note || !userId) return null;
  return item.employeeId === userId || item.employee?.id === userId ? note : null;
}

type ApprovalCardProps = {
  tab: Tab;
  item: ApprovalItem;
  /** set → the admin's own item: the note replaces the buttons (the API refuses self-review) */
  ownNote: string | null;
  /** a decision on this item is being confirmed or sent */
  busy: boolean;
  onAct: (item: ApprovalItem, spec: ActionSpec) => Promise<void>;
};

function ApprovalCard({ tab, item, ownNote, busy, onAct }: ApprovalCardProps) {
  const who = whoOf(tab, item);
  const d = detailsOf(tab, item);
  const actions = actionsFor(tab, item);
  const hasBody = !!(d.line || d.reason || d.meta);
  const link = d.link;

  return (
    <Card padded={false}>
      <ListItem
        leading={<Avatar name={who} />}
        title={who}
        subtitle={d.subtitle}
        detail={d.detail}
        chevron={false}
        last
      />
      {hasBody ? (
        <View style={styles.body}>
          {d.line ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.line}>
              {d.line}
            </Text>
          ) : null}
          {d.reason ? (
            <Text maxFontSizeMultiplier={1.6} numberOfLines={3} style={styles.reason}>
              {d.reason}
            </Text>
          ) : null}
          {d.meta ? (
            <Text maxFontSizeMultiplier={1.6} style={styles.meta}>
              {d.meta}
            </Text>
          ) : null}
        </View>
      ) : null}
      {link ? (
        <ListItem
          icon={link.icon}
          tint="blue"
          title={link.title}
          subtitle={link.subtitle}
          onPress={() => void openFile(fileUrl(link.url))}
          accessibilityHint="Opens the file"
          last
        />
      ) : null}
      {ownNote ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.own}>
          {ownNote}
        </Text>
      ) : (
        <View style={styles.actions}>
          <Button
            title="Approve"
            variant="tinted"
            tone="success"
            size="md"
            onPress={() => onAct(item, actions.approve)}
            disabled={busy}
            style={styles.flex}
            accessibilityLabel={`Approve, ${who}`}
          />
          {actions.reject ? (
            <Button
              title="Reject"
              variant="plain"
              tone="danger"
              size="md"
              onPress={() => {
                const spec = actions.reject;
                return spec ? onAct(item, spec) : undefined;
              }}
              disabled={busy}
              style={styles.flex}
              accessibilityLabel={`Reject, ${who}`}
            />
          ) : null}
        </View>
      )}
    </Card>
  );
}

export default function AdminApprovals() {
  const { user } = useAuth();
  const router = useRouter();
  const counts = usePendingCounts();
  const params = useLocalSearchParams<{ tab?: string }>();
  const paramTab = parseTab(params.tab);

  const [chosen, setChosen] = useState<Tab | null>(paramTab);
  const [error, setError] = useState<string | null>(null);

  // A deep link (?tab=…) wins every time it arrives. The param is consumed after use: this tab screen
  // stays mounted, so an unchanged ?tab= on the next dashboard tap would otherwise be ignored.
  useEffect(() => {
    if (paramTab) {
      setChosen(paramTab);
      setError(null);
      router.setParams({ tab: "" });
    }
  }, [paramTab, router]);

  // Otherwise open the first queue with something waiting, once the counts are known; then freeze it.
  const autoTab: Tab | null = counts.status === "loading" ? null : firstWaiting(counts);
  useEffect(() => {
    if (chosen === null && autoTab !== null) setChosen(autoTab);
  }, [chosen, autoTab]);
  const tab: Tab | null = chosen ?? autoTab;

  const tabRef = useRef<Tab | null>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Items with a decision in flight (confirm sheet open or request running). The ref is the
  // synchronous guard against a double tap; the state drives the disabled buttons.
  const busyRef = useRef<Set<string>>(new Set());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setBusy = (key: string, on: boolean) => {
    if (on) busyRef.current.add(key);
    else busyRef.current.delete(key);
    setBusyKeys(new Set(busyRef.current));
  };

  const list = useApi<ApprovalItem[]>(() => (tab ? fetchQueue(tab) : Promise.resolve([])), [tab], {
    refetchOnFocus: true,
    staleMs: 30000,
    enabled: tab !== null,
  });

  const chipCounts: Partial<Record<Tab, number | null>> = {
    LEAVES: counts.leaves,
    EXPENSES: counts.expenses,
    EXTRA_HOURS: counts.extraHours,
    NEW_EMPLOYEES: counts.newEmployees,
    DOCUMENTS: counts.documents,
  };

  const selectTab = (t: Tab) => {
    setChosen(t);
    setError(null);
  };

  const onRefresh = async () => {
    await Promise.all([list.refresh(), counts.reload()]);
  };

  const run = async (startTab: Tab, item: ApprovalItem, spec: ActionSpec) => {
    setError(null);
    const ok = await confirm(spec.confirm);
    if (!ok) return;

    const key = keyOf(item);
    const index = (list.data ?? []).findIndex((i) => keyOf(i) === key);
    list.setData((prev) => (prev ?? []).filter((i) => keyOf(i) !== key));

    try {
      await spec.call();
      const q = COUNT_KEY[startTab];
      if (q) counts.decrement(q);
      if (tabRef.current === startTab) await list.reload();
      toast.show({ message: spec.done, tone: "success" });
      void haptic("success");
      invalidatePendingCounts();
    } catch (e) {
      void haptic("error");
      const sameTab = tabRef.current === startTab;
      if (isAlreadyHandled(e)) {
        // No longer pending: never put it back as actionable; show the server's truth instead.
        setError(ALREADY_HANDLED);
        if (sameTab) void list.reload();
        invalidatePendingCounts();
        return;
      }
      if (sameTab) {
        // Only restore an item that was still listed when the decision was confirmed.
        if (index >= 0) list.setData((prev) => restore(prev, item, index));
        else void list.reload();
      }
      setError(describeError(e, "Couldn't complete that. Please try again."));
    }
  };

  const act = async (item: ApprovalItem, spec: ActionSpec) => {
    const startTab = tabRef.current;
    if (!startTab) return;
    const busyKey = busyKeyOf(startTab, item);
    if (busyRef.current.has(busyKey)) return;
    setBusy(busyKey, true);
    try {
      await run(startTab, item, spec);
    } finally {
      setBusy(busyKey, false);
    }
  };

  const queue: Tab = tab ?? "LEAVES";

  return (
    <Screen header="none" onRefresh={onRefresh} refreshing={list.refreshing}>
      <LargeTitle title="Approvals" subtitle={counts.status === "ok" ? `${counts.total} waiting` : undefined} />
      <Chips
        options={TABS}
        value={queue}
        onChange={selectTab}
        labels={LABELS}
        counts={chipCounts}
        mode="pills"
        wrap
        accessibilityLabel="Approval queues"
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <AsyncList
        state={list}
        skeleton="cards"
        skeletonCount={3}
        keyExtractor={(item, i) => keyOf(item) || `row-${i}`}
        empty={{
          icon: "checkmark-done-outline",
          title: `Nothing pending in ${QUEUE_NAME[queue]}`,
          text: "New requests will show up here.",
        }}
        renderItem={(item) => (
          <ApprovalCard
            tab={queue}
            item={item}
            ownNote={ownNoteFor(queue, item, user?.id)}
            busy={busyKeys.has(busyKeyOf(queue, item))}
            onAct={act}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm, gap: spacing.xs },
  line: { ...type.subhead, color: colors.ink },
  reason: { ...type.subhead, color: colors.sub },
  meta: { ...type.footnote, color: colors.tertiary },
  own: {
    ...type.footnote,
    color: colors.sub,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  flex: { flex: 1 },
});
