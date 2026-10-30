import React, { useState } from "react";
import { useRouter } from "expo-router";
import { apiFetch, fmtMoney, fmtRange } from "@/lib/api";
import { formatStatus } from "@/lib/theme";
import { Screen, Chips, StatusPill, useApi } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";
import { BOOKING_STATUS } from "@/lib/campaigns";

// Campaign bookings — the internal portal's /campaigns queue (GET /admin/campaigns, Admin /
// Super Admin only): self-serve client bookings to review, post and deliver.

type Row = {
  id: string;
  name: string;
  brand: string;
  client: string;
  status: string;
  format: string | null;
  campaignType: string;
  totalPaise: number;
  launchFrom: string | null;
  launchTo: string | null;
  paidAt: string | null;
  updatedAt: string;
  itemCount: number;
  liveCount: number;
};

const FILTERS = ["todo", "changes", "done", "closed", "all"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = {
  todo: "To do",
  changes: "Waiting on client",
  done: "Delivered",
  closed: "Rejected / refunded",
  all: "All",
};
const MATCH: Record<Filter, (s: string) => boolean> = {
  todo: (s) => ["paid_pending_review", "approved", "publishing"].includes(s),
  changes: (s) => ["changes_requested", "awaiting_payment"].includes(s),
  done: (s) => ["completed", "partially_published"].includes(s),
  closed: (s) => ["rejected", "refunded"].includes(s),
  all: () => true,
};

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

/** Paise → "₹1,23,456". */
function money(paise: number | null | undefined): string {
  return paise == null ? "—" : fmtMoney(paise / 100);
}

export default function AdminCampaigns() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("todo");
  const state = useApi<Row[]>(() => apiFetch<Row[]>("/admin/campaigns"));
  const all = state.data ?? [];
  const rows = all.filter((r) => MATCH[filter](r.status));
  const counts: Partial<Record<Filter, number>> | undefined = state.data
    ? Object.fromEntries(FILTERS.map((f) => [f, all.filter((r) => MATCH[f](r.status)).length]))
    : undefined;

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList<Row>
        state={state}
        items={rows}
        grouped
        header={
          <Chips
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            labels={FILTER_LABEL}
            counts={counts}
            accessibilityLabel="Filter campaigns"
          />
        }
        keyExtractor={(r) => r.id}
        empty={{
          icon: "megaphone-outline",
          title: filter === "todo" ? "Nothing to review or post right now" : "No campaigns here",
        }}
        renderItem={(r) => {
          const label = BOOKING_STATUS[r.status]?.label ?? formatStatus(r.status);
          const accounts = `${r.itemCount} account${r.itemCount === 1 ? "" : "s"}${r.liveCount ? ` · ${r.liveCount} live` : ""}`;
          const when = r.launchFrom ? fmtRange(r.launchFrom, r.launchTo) : "No dates";
          return (
            <ListItem
              title={r.name}
              subtitle={`${r.client} · ${accounts}\n${when} · ${money(r.totalPaise)}${r.paidAt ? " · paid online" : ""}`}
              trailing={<StatusPill status={BOOKING_PILL[r.status] ?? r.status} label={label} size="sm" />}
              onPress={() => router.push(`/admin-campaign/${r.id}`)}
              accessibilityLabel={`${r.name}, ${label}, ${r.client}, ${accounts}, ${when}, ${money(r.totalPaise)}`}
            />
          );
        }}
      />
    </Screen>
  );
}
