"use client";
/**
 * Seen tracking (spec §5.4, §9.6). An IntersectionObserver (threshold 0.5, rooted at the
 * thread scroller) records the highest `seq` whose row was at least half visible, and the
 * ids of rendered messages that mention me or reply to my message and were actually seen.
 * The SyncEngine reads `take()` as its ack; ids leave the ledger only once a sync that
 * carried them succeeded (`confirm`), so a failed poll never loses a "seen".
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { PIPELINE_LIMITS, type PipelineSyncAck } from "@dashmani/shared";

export class AckLedger {
  maxSeq = 0;
  private seen = new Set<string>();
  private opened = false;

  markSeq(seq: number) {
    if (seq > this.maxSeq) this.maxSeq = seq;
  }

  markSeenId(id: string) {
    this.seen.add(id);
  }

  take(): PipelineSyncAck {
    const ack: PipelineSyncAck = { seq: this.maxSeq };
    if (this.seen.size) ack.seen = Array.from(this.seen).slice(0, PIPELINE_LIMITS.seenIdsMax);
    if (!this.opened) ack.open = true;
    return ack;
  }

  confirm(ack: PipelineSyncAck) {
    if (ack.open) this.opened = true;
    for (const id of ack.seen ?? []) this.seen.delete(id);
  }
}

export interface SeenInfo {
  seq: number;
  /** Mentions me or replies to my message. */
  interesting: boolean;
  id: string;
}

export function useSeenObserver(root: React.RefObject<HTMLElement>, ledger: AckLedger) {
  const info = useRef(new WeakMap<Element, SeenInfo>());
  const observer = useRef<IntersectionObserver | null>(null);
  const pending = useRef(new Set<Element>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting || e.intersectionRatio < 0.5) continue;
          const i = info.current.get(e.target);
          if (!i) continue;
          ledger.markSeq(i.seq);
          if (i.interesting) ledger.markSeenId(i.id);
        }
      },
      { root: root.current, threshold: 0.5 },
    );
    observer.current = io;
    pending.current.forEach((el) => io.observe(el));
    pending.current.clear();
    return () => {
      io.disconnect();
      observer.current = null;
    };
  }, [root, ledger]);

  // Stable ref callbacks per (id, seq, interesting), so memoised rows don't re-render.
  const cache = useRef(new Map<string, (el: HTMLElement | null) => void>());

  /** Ref callback factory: `ref={observe(info)}`. */
  const observe = useCallback((i: SeenInfo) => {
    const key = `${i.id}:${i.seq}:${i.interesting ? 1 : 0}`;
    let cb = cache.current.get(key);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (!el) return;
        info.current.set(el, i);
        if (observer.current) observer.current.observe(el);
        else pending.current.add(el);
      };
      if (cache.current.size > 500) cache.current.clear();
      cache.current.set(key, cb);
    }
    return cb;
  }, []);

  return useMemo(() => ({ observe }), [observe]);
}
