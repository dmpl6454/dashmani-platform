"use client";
import { Pill } from "../campaigns/_ds";

// Creator statuses as staff see them. `_` keeps Next from routing it.

export const CREATOR_STATUS: Record<string, { label: string; color: string }> = {
  in_review: { label: "In review", color: "#E9BD62" },
  approved: { label: "Approved", color: "#00D7A0" },
  draft: { label: "Setting up", color: "#738395" },
  rejected: { label: "Not approved", color: "#FB7185" },
  suspended: { label: "Suspended", color: "#F59E66" },
  closed: { label: "Closed", color: "#4E5F70" },
};

export const CONNECTION_STATUS: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: "Connected", color: "#00D7A0" },
  PARTIAL_SCOPE: { label: "Missing permissions", color: "#E9BD62" },
  NEEDS_REAUTH_SOON: { label: "Reconnect soon", color: "#F59E66" },
  NEEDS_REAUTH: { label: "Needs reconnect", color: "#FB7185" },
  REVOKED: { label: "Disconnected", color: "#4E5F70" },
};

export function CreatorStatusPill({ status }: { status: string }) {
  const s = CREATOR_STATUS[status] ?? { label: status, color: "#738395" };
  return <Pill label={s.label} color={s.color} />;
}

export function ConnectionPill({ status }: { status: string | null }) {
  if (!status) return <Pill label="Not connected" color="#4E5F70" />;
  const s = CONNECTION_STATUS[status] ?? { label: status, color: "#738395" };
  return <Pill label={s.label} color={s.color} />;
}
