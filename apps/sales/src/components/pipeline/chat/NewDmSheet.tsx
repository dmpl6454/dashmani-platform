"use client";
/** "New message": pick one person (or yourself) → open (or create) the DM with them. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePipeline } from "../provider";
import { Sheet } from "../ui/Sheet";
import { PeoplePicker } from "../project/PeoplePicker";
import { describeError, plApi } from "../api";
import { chatHref } from "./use-chat";

export function NewDmSheet({ open, onClose, onOpened }: { open: boolean; onClose: () => void; onOpened: () => void }) {
  const router = useRouter();
  const { meId } = usePipeline();
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPick([]);
      setError(null);
    }
  }, [open]);

  const start = async (userId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await plApi.openDm(userId);
      onOpened();
      onClose();
      router.push(chatHref(r.id));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New message"
      footer={
        <div className="flex justify-between gap-2">
          <button type="button" disabled={busy} onClick={() => void start(meId)} className="h-11 px-4 border border-border text-[14px] font-semibold disabled:opacity-50">
            Message yourself
          </button>
          <button type="button" disabled={busy || pick.length === 0} onClick={() => void start(pick[0])} className="h-11 px-4 bg-indigo text-white text-[14px] font-semibold disabled:opacity-50">
            {busy ? "Opening…" : "Open"}
          </button>
        </div>
      }
    >
      <PeoplePicker value={pick} onChange={setPick} single label="To" exclude={[meId]} />
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      )}
    </Sheet>
  );
}
