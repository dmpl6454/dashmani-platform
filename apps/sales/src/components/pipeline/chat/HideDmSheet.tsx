"use client";
/**
 * "Delete conversation?" for a DM — it only leaves MY list (POST /pipeline/dms/:id/hide). The
 * other person keeps it, and it comes back for me with a new message or when I open it again.
 */
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";

export interface HideableDm {
  id: string;
  /** The other person's name ("yourself" for the self-DM). */
  name: string;
  isSelf: boolean;
}

export function HideDmSheet({ dm, onClose }: { dm: HideableDm | null; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const openId = useSearchParams().get("id");
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hide = async () => {
    if (!dm) return;
    setBusy(true);
    setError(null);
    try {
      await plApi.hideDm(dm.id);
      void mutate((key) => Array.isArray(key) && key[0] === "/pipeline/conversations");
      toast.show({ text: "Conversation deleted from your list" });
      onClose();
      if (pathname === "/pipeline/chat" && openId === dm.id) router.push("/pipeline/chat");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={!!dm}
      onClose={onClose}
      title="Delete this conversation?"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 px-4 border border-border text-[14px] font-semibold">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={() => void hide()} className="h-11 px-4 bg-danger text-bg text-[14px] font-semibold disabled:opacity-40">
            {busy ? "Deleting…" : "Delete conversation"}
          </button>
        </div>
      }
    >
      <p className="text-[14px] text-ink-2">
        {dm?.isSelf
          ? "Your notes to yourself leave your list. They come back when you open “Message yourself” again."
          : `This removes your conversation with ${dm?.name ?? "them"} from your list. They will still have it, and it comes back if either of you sends a new message.`}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Sheet>
  );
}
