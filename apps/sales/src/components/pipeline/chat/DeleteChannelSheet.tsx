"use client";
/**
 * "Delete #name?" — type the name to confirm (owner or admin; the server re-checks). Used from
 * the sidebar row's ⋯ menu, the channel header's ⋯ menu and the About & members panel.
 * Afterwards every chat list re-reads, and a page showing the channel leaves it.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";

export interface DeletableChannel {
  id: string;
  name: string;
  parentProjectId?: string | null;
}

/** Owner or admin: who sees "Delete channel" (button visibility only). */
export const canDeleteChannel = (ownerId: string | undefined, meId: string, isAdmin: boolean) => isAdmin || ownerId === meId;

export function DeleteChannelSheet({ channel, onClose }: { channel: DeletableChannel | null; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const openId = useSearchParams().get("id");
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTyped("");
    setError(null);
  }, [channel?.id]);

  const matches = !!channel && typed.trim().replace(/^#/, "").toLowerCase() === channel.name.toLowerCase();

  const remove = async () => {
    if (!channel) return;
    setBusy(true);
    setError(null);
    try {
      await plApi.deleteChannel(channel.id, typed);
      void mutate((key) => Array.isArray(key) && (key[0] === "/pipeline/conversations" || key[0] === "/pipeline/campaign-channels"));
      toast.show({ text: `#${channel.name} was deleted` });
      onClose();
      if (pathname === "/pipeline/chat" && openId === channel.id) {
        router.push(channel.parentProjectId ? `/pipeline/view?id=${encodeURIComponent(channel.parentProjectId)}` : "/pipeline/chat");
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!channel}
      onClose={onClose}
      title={channel ? `Delete #${channel.name}?` : "Delete channel"}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 px-4 border border-border text-[14px] font-semibold">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !matches}
            onClick={() => void remove()}
            className="h-11 px-4 bg-danger text-bg text-[14px] font-semibold disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete channel"}
          </button>
        </div>
      }
    >
      <p className="text-[14px] text-ink-2">
        The channel and all its messages disappear for everyone, right away. This can&apos;t be undone from the app.
      </p>
      <label htmlFor="del-confirm" className="mt-4 block text-[13px] font-semibold text-ink-2">
        Type <span className="text-ink">{channel?.name}</span> to confirm
      </label>
      <input
        id="del-confirm"
        autoFocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches) void remove();
        }}
        autoComplete="off"
        className="mt-1.5 w-full h-11 px-3 border border-border bg-bg text-[15px] outline-none focus:border-danger"
      />
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Sheet>
  );
}
