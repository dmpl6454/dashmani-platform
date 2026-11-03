"use client";
/**
 * "Create a channel" — Slack's dialog: a name (shown as the slug it will become), an optional
 * description, Public / Private, and people to add. The idempotency key is minted when the
 * sheet opens, so a double click or a retry after a lost answer creates ONE channel.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Lock } from "lucide-react";
import { makeClientId, pipelineValidators as V } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { Sheet } from "../ui/Sheet";
import { PeoplePicker } from "../project/PeoplePicker";
import { describeError, plApi } from "../api";
import { chatHref } from "./use-chat";

export function NewChannelSheet({
  open,
  onClose,
  onCreated,
  campaign,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** Create the channel inside this campaign (its own sidebar; public = everyone on it). */
  campaign?: { id: string; title: string } | null;
}) {
  const router = useRouter();
  const { meId } = usePipeline();
  const [clientId, setClientId] = useState(makeClientId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setClientId(makeClientId());
    setName("");
    setDescription("");
    setIsPrivate(false);
    setPeople([]);
    setError(null);
  }, [open]);

  const slug = V.slugifyChannelName(name);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug) {
      setError("Give the channel a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await plApi.createChannel({
        clientId,
        projectId: campaign?.id,
        name: slug,
        description: description.trim() || undefined,
        isPrivate,
        memberIds: people,
      });
      onCreated();
      onClose();
      router.push(chatHref(r.id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={campaign ? `New channel in ${campaign.title}` : "Create a channel"}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-11 px-4 border border-border text-[14px] font-semibold">
            Cancel
          </button>
          <button type="submit" form="new-channel" disabled={busy || !slug} className="h-11 px-4 bg-indigo text-white text-[14px] font-semibold disabled:opacity-50">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      }
    >
      <form id="new-channel" onSubmit={submit} className="space-y-5">
        <div>
          <label htmlFor="ch-name" className="block text-[13px] font-semibold text-ink-2 mb-1.5">
            Name
          </label>
          <div className="flex items-center border border-border bg-bg focus-within:border-indigo">
            <span className="pl-3 text-ink-3">{isPrivate ? <Lock size={15} aria-hidden /> : <Hash size={15} aria-hidden />}</span>
            <input
              id="ch-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={V.PIPELINE_CHANNEL_NAME_MAX + 20}
              placeholder="e.g. plan-budget"
              className="flex-1 h-11 px-2 bg-transparent text-[15px] outline-none"
            />
          </div>
          {name && slug !== name && <p className="mt-1 text-[12px] text-ink-3">It will be called #{slug || "…"}</p>}
        </div>

        <div>
          <label htmlFor="ch-desc" className="block text-[13px] font-semibold text-ink-2 mb-1.5">
            Description <span className="font-normal text-ink-4">(optional)</span>
          </label>
          <input
            id="ch-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={250}
            placeholder="What's this channel about?"
            className="w-full h-11 px-3 border border-border bg-bg text-[15px] outline-none focus:border-indigo"
          />
        </div>

        <fieldset>
          <legend className="text-[13px] font-semibold text-ink-2 mb-2">Visibility</legend>
          {(
            [
              [
                false,
                campaign ? "Public — everyone on this campaign" : "Public — anyone",
                campaign
                  ? "Everyone on the campaign is added now; anyone in the team can open and join it."
                  : "Anyone in the team can find and join this channel.",
              ],
              [true, "Private — only specific people", "Only people you add can see it or read its messages."],
            ] as const
          ).map(([val, label, help]) => (
            <label key={String(val)} className={`flex gap-3 p-3 border mb-2 cursor-pointer ${isPrivate === val ? "border-indigo bg-indigo/10" : "border-border"}`}>
              <input type="radio" name="vis" checked={isPrivate === val} onChange={() => setIsPrivate(val)} className="mt-1 accent-indigo" />
              <span>
                <span className="block text-[14px] font-semibold text-ink">{label}</span>
                <span className="block text-[13px] text-ink-3">{help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <PeoplePicker value={people} onChange={setPeople} exclude={[meId]} label="Add people (optional)" max={50} />

        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
