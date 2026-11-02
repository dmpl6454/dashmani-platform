/**
 * Unsent messages survive a reload (spec §9.4). Stored under `pl:v1:<userId>:outbox`.
 * Every item carries `authorId` and is DISCARDED when it is not the current user, so
 * person A's unsent message can never post as person B on a shared browser.
 */
import { plKey, plReadJson, plWrite, plRemove } from "@/lib/pipeline-storage";

export interface OutboxItem {
  clientId: string;
  authorId: string;
  projectId: string;
  parentId: string | null;
  body: string;
  /** ms epoch. */
  createdAt: number;
}

/** Entries younger than this replay automatically; older ones ask "Send / Discard". */
export const OUTBOX_AUTO_REPLAY_MS = 5 * 60_000;
const MAX_ITEMS = 50;

function key(userId: string) {
  return plKey(userId, "outbox");
}

function isItem(x: unknown): x is OutboxItem {
  const o = x as OutboxItem;
  return (
    !!o &&
    typeof o.clientId === "string" &&
    typeof o.authorId === "string" &&
    typeof o.projectId === "string" &&
    (o.parentId === null || typeof o.parentId === "string") &&
    typeof o.body === "string" &&
    typeof o.createdAt === "number"
  );
}

export function loadOutbox(userId: string): OutboxItem[] {
  const raw = plReadJson<unknown[]>(key(userId));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isItem).filter((i) => i.authorId === userId);
}

function save(userId: string, items: OutboxItem[]) {
  if (items.length === 0) plRemove(key(userId));
  else plWrite(key(userId), JSON.stringify(items.slice(-MAX_ITEMS)));
}

export function outboxPut(userId: string, item: OutboxItem): void {
  if (item.authorId !== userId) return;
  const items = loadOutbox(userId).filter((i) => i.clientId !== item.clientId);
  items.push(item);
  save(userId, items);
}

export function outboxRemove(userId: string, clientId: string): void {
  const items = loadOutbox(userId);
  const next = items.filter((i) => i.clientId !== clientId);
  if (next.length !== items.length) save(userId, next);
}
