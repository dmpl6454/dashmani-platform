"use client";
/** "Browse channels": every public channel (and the private ones I'm in), search, Join / Open. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Hash, Lock } from "lucide-react";
import { PL_SWR } from "@/lib/pipeline-swr";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import { describeError, plApi } from "../api";
import { chatHref } from "./use-chat";

export function BrowseChannelsSheet({
  open,
  onClose,
  onJoined,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onJoined: () => void;
  onCreate: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setError(null);
    }
  }, [open]);

  const { data, error: loadError, mutate } = useSWR(open ? ["/pipeline/channels/browse", debounced] : null, () => plApi.browseChannels(debounced), PL_SWR);

  const go = (id: string) => {
    onClose();
    router.push(chatHref(id));
  };

  const join = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await plApi.joinChannel(id);
      onJoined();
      void mutate();
      go(id);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Browse channels" wide>
      <div className="flex gap-2 mb-4">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by channel name"
          aria-label="Search channels"
          className="flex-1 h-11 px-3 border border-border bg-bg text-[15px] outline-none focus:border-indigo"
        />
        <button type="button" onClick={onCreate} className="h-11 px-4 bg-indigo text-white text-[14px] font-semibold">
          Create
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-danger">
          {error}
        </p>
      )}
      {loadError && !data ? (
        <p className="text-[13px] text-ink-3">
          Couldn&apos;t load channels.{" "}
          <button type="button" className="underline font-semibold" onClick={() => void mutate()}>
            Try again
          </button>
        </p>
      ) : !data ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : data.channels.length === 0 ? (
        <p className="py-6 text-center text-[14px] text-ink-3">{debounced ? `No channel matches "${debounced}".` : "No channels yet — create the first one."}</p>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {data.channels.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-3">
              <span className="text-ink-3 shrink-0">{c.isPrivate ? <Lock size={15} aria-label="Private" /> : <Hash size={15} aria-hidden />}</span>
              <button type="button" onClick={() => go(c.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[15px] font-semibold text-ink">{c.name}</span>
                <span className="block truncate text-[12.5px] text-ink-3">
                  {c.joined ? "Joined · " : ""}
                  {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  {c.description ? ` · ${c.description}` : ""}
                </span>
              </button>
              {c.joined ? (
                <button type="button" onClick={() => go(c.id)} className="h-9 px-3 border border-border text-[13px] font-semibold">
                  Open
                </button>
              ) : (
                <button type="button" disabled={busy === c.id} onClick={() => void join(c.id)} className="h-9 px-3 bg-indigo text-white text-[13px] font-semibold disabled:opacity-50">
                  {busy === c.id ? "Joining…" : "Join"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
