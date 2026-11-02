"use client";
/**
 * Shoot Desk — ported from the HR portal (apps/hr/src/components/pipeline/shoots/ShootDesk.tsx) for
 * the sales portal (2026-11-02): same API, dark-theme swaps (bg-ink → bg-indigo, text-indigo →
 * text-indigo-light) and the static-export project link /pipeline/view?id=. Port HR changes here.
 *
 * Shoot Desk (2026-11-02): paparazzi / event assignments — who covers what, where and when,
 * and whether the footage is in. Upcoming | Mine | Past; anyone on the Pipeline can add or
 * update a shoot (the Pipeline's open-access rule). Footage is a LINK (NAS, Drive…), never an
 * upload. Edits carry the `rev` they read; a 409 refreshes the list with the other person's
 * version. Data: GET /pipeline/shoots, on mount and on focus (no polling).
 */
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ChevronLeft, ExternalLink, Plus } from "lucide-react";
import { pipelineWork as W } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, isApiError, plApi } from "../api";
import { PipelineHeader } from "../header/PipelineHeader";
import { PeoplePicker } from "../project/PeoplePicker";
import { Skeleton } from "../ui/Skeleton";

type View = "upcoming" | "mine" | "past";
const VIEWS: Array<{ key: View; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "mine", label: "Mine" },
  { key: "past", label: "Past" },
];

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo";
const btn = "h-11 px-3.5 rounded-xl text-[13px] font-semibold disabled:opacity-50";
const btnPrimary = `${btn} bg-indigo text-white`;
const btnGhost = `${btn} border border-border text-ink-2 hover:bg-muted`;

const STATUS_TONE: Record<W.PipelineShootStatus, string> = {
  assigned: "bg-indigo-soft text-indigo-light",
  on_site: "bg-attention-bg text-attention",
  uploaded: "bg-success-bg text-success",
  done: "bg-muted text-ink-2",
  cancelled: "bg-muted text-ink-4 line-through",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const h = d.getHours();
  return `${day}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type Form = {
  title: string;
  event: string;
  location: string;
  callTime: string;
  camera: string[];
  contact: string;
  requirements: string;
  deadline: string;
  embargoUntil: string;
};
const emptyForm = (): Form => ({
  title: "", event: "", location: "", callTime: "", camera: [], contact: "", requirements: "", deadline: "", embargoUntil: "",
});
const formFrom = (s: W.PipelineShootDto): Form => ({
  title: s.title,
  event: s.event,
  location: s.location,
  callTime: toLocalInput(s.callTime),
  camera: s.camera ? [s.camera.id] : [],
  contact: s.contact,
  requirements: s.requirements,
  deadline: toLocalInput(s.deadline),
  embargoUntil: toLocalInput(s.embargoUntil),
});

function ShootFields({ f, set }: { f: Form; set: (f: Form) => void }) {
  const on = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-2.5">
      <input className={inputCls} placeholder="Title — e.g. Airport arrival: Alia" value={f.title} maxLength={W.PIPELINE_WORK_LIMITS.shootTitleMax} onChange={on("title")} aria-label="Title" />
      <input className={inputCls} placeholder="Event" value={f.event} maxLength={W.PIPELINE_WORK_LIMITS.shootFieldMax} onChange={on("event")} aria-label="Event" />
      <input className={inputCls} placeholder="Location" value={f.location} maxLength={W.PIPELINE_WORK_LIMITS.shootFieldMax} onChange={on("location")} aria-label="Location" />
      <label className="block text-[12.5px] font-semibold text-ink-2">
        Call time
        <input type="datetime-local" className={`${inputCls} mt-1`} value={f.callTime} onChange={on("callTime")} />
      </label>
      <PeoplePicker value={f.camera} onChange={(ids) => set({ ...f, camera: ids })} single label="Camera person" />
      <input className={inputCls} placeholder="On-site contact (name, phone)" value={f.contact} maxLength={W.PIPELINE_WORK_LIMITS.shootFieldMax} onChange={on("contact")} aria-label="On-site contact" />
      <textarea
        value={f.requirements}
        onChange={on("requirements")}
        maxLength={W.PIPELINE_WORK_LIMITS.shootRequirementsMax}
        rows={3}
        placeholder="What to cover — shots, angles, people"
        aria-label="What to cover"
        className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <label className="block text-[12.5px] font-semibold text-ink-2 min-w-0">
          Footage due by
          <input type="datetime-local" className={`${inputCls} mt-1`} value={f.deadline} onChange={on("deadline")} />
        </label>
        <label className="block text-[12.5px] font-semibold text-ink-2 min-w-0">
          Embargo — not before
          <input type="datetime-local" className={`${inputCls} mt-1`} value={f.embargoUntil} onChange={on("embargoUntil")} />
        </label>
      </div>
    </div>
  );
}

function NewShoot({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState<Form>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const callTime = fromLocalInput(f.callTime);
    if (!f.title.trim()) return setErr("Give the shoot a title.");
    if (!callTime) return setErr("Set the call time.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.createShoot({
        title: f.title.trim(),
        callTime,
        event: f.event.trim(),
        location: f.location.trim(),
        cameraId: f.camera[0] ?? null,
        contact: f.contact.trim(),
        requirements: f.requirements.trim(),
        deadline: fromLocalInput(f.deadline),
        embargoUntil: fromLocalInput(f.embargoUntil),
      });
      onDone();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 rounded-xl border border-border bg-surface p-3.5">
      <h2 className="mb-2.5 text-[14px] font-bold text-ink">New shoot</h2>
      <ShootFields f={f} set={setF} />
      <div className="mt-3 flex gap-2">
        <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
          Add shoot
        </button>
        <button type="button" className={btnGhost} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
      {err && <p role="alert" className="mt-2 text-[13px] text-danger">{err}</p>}
    </div>
  );
}

function ShootCard({ s, onChanged }: { s: W.PipelineShootDto; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<Form>(() => formFrom(s));
  const [status, setStatus] = useState<W.PipelineShootStatus>(s.status);
  const [uploadUrl, setUploadUrl] = useState(s.uploadUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const changes: W.EditShootInput["changes"] = {};
    const callTime = fromLocalInput(f.callTime);
    if (!callTime) return setErr("Set the call time.");
    if (f.title.trim() !== s.title) changes.title = f.title.trim();
    if (callTime !== s.callTime) changes.callTime = callTime;
    if (f.event.trim() !== s.event) changes.event = f.event.trim();
    if (f.location.trim() !== s.location) changes.location = f.location.trim();
    if ((f.camera[0] ?? null) !== (s.camera?.id ?? null)) changes.cameraId = f.camera[0] ?? null;
    if (f.contact.trim() !== s.contact) changes.contact = f.contact.trim();
    if (f.requirements.trim() !== s.requirements) changes.requirements = f.requirements.trim();
    const deadline = fromLocalInput(f.deadline);
    if (deadline !== s.deadline) changes.deadline = deadline;
    const embargo = fromLocalInput(f.embargoUntil);
    if (embargo !== s.embargoUntil) changes.embargoUntil = embargo;
    if (status !== s.status) changes.status = status;
    const url = uploadUrl.trim() || null;
    if (url !== s.uploadUrl) changes.uploadUrl = url;
    if (Object.keys(changes).length === 0) return setEditing(false);
    const parsed = W.editShootSchema.safeParse({ base: s.rev, changes });
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.editShoot(s.id, parsed.data);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
      if (isApiError(e) && e.code === "SHOOT_CONFLICT") onChanged();
    } finally {
      setBusy(false);
    }
  };

  const late = s.deadline && Date.parse(s.deadline) < Date.now() && (s.status === "assigned" || s.status === "on_site");

  return (
    <li className="rounded-xl border border-border bg-surface px-3.5 py-3 min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="text-[14.5px] font-bold text-ink break-words">{s.title}</p>
          <p className="mt-0.5 text-[13px] text-ink-3 break-words">
            {[s.event, s.location].filter(Boolean).join(" · ") || "No event or place yet"}
          </p>
        </div>
        <span className={`shrink-0 inline-flex items-center h-6 px-2 rounded-full text-[11.5px] font-semibold ${STATUS_TONE[s.status]}`}>
          {W.PIPELINE_SHOOT_STATUS_LABEL[s.status]}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2">
        Call {when(s.callTime)} · {s.camera ? s.camera.name : "No camera person yet"}
      </p>
      {s.deadline && (
        <p className={`text-[12.5px] ${late ? "text-danger font-semibold" : "text-ink-3"}`}>
          Footage {late ? "was due" : "due"} {when(s.deadline)}
        </p>
      )}
      {s.embargoUntil && Date.parse(s.embargoUntil) > Date.now() && (
        <p className="text-[12.5px] text-attention font-semibold">Embargo until {when(s.embargoUntil)}</p>
      )}
      {s.contact && <p className="text-[12.5px] text-ink-3 break-words">Contact: {s.contact}</p>}
      {s.requirements && <p className="mt-1 text-[13px] text-ink-2 whitespace-pre-wrap break-words">{s.requirements}</p>}
      {s.project && (
        <Link href={`/pipeline/view?id=${s.project.id}`} className="mt-1 inline-block text-[13px] font-semibold text-indigo-light">
          Project: {s.project.title}
        </Link>
      )}
      {s.uploadUrl && (
        <a href={s.uploadUrl} target="_blank" rel="noopener noreferrer" className="mt-1 flex items-center gap-1 text-[13px] text-indigo-light underline min-w-0">
          <ExternalLink size={13} className="shrink-0" />
          <span className="truncate">Footage</span>
        </a>
      )}

      {editing ? (
        <div className="mt-3 space-y-2.5">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as W.PipelineShootStatus)} aria-label="Status">
            {W.PIPELINE_SHOOT_STATUSES.map((k) => (
              <option key={k} value={k}>
                {W.PIPELINE_SHOOT_STATUS_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            className={inputCls}
            type="url"
            inputMode="url"
            placeholder="Link to the footage (needed for Footage uploaded)"
            value={uploadUrl}
            maxLength={W.PIPELINE_WORK_LIMITS.urlMax}
            onChange={(e) => setUploadUrl(e.target.value)}
            aria-label="Link to the footage"
          />
          <ShootFields f={f} set={setF} />
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="mt-1 h-11 text-[13px] font-semibold text-indigo-light" onClick={() => setEditing(true)}>
          Update
        </button>
      )}
      {err && <p role="alert" className="mt-2 text-[13px] text-danger">{err}</p>}
    </li>
  );
}

export function ShootDesk({ initialView }: { initialView: View }) {
  const [view, setView] = useState<View>(initialView);
  const [adding, setAdding] = useState(false);
  const { data, error, mutate } = useSWR(`pl-shoots:${view}`, () => plApi.shoots(view), { ...PL_SWR, revalidateOnFocus: true });

  const back = (
    <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
      <ChevronLeft size={20} />
    </Link>
  );

  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader
        title="Shoot Desk"
        left={back}
        actions={
          !adding ? (
            <button type="button" onClick={() => setAdding(true)} className="h-11 px-3 inline-flex items-center gap-1.5 rounded-xl bg-indigo text-white text-[13px] font-semibold">
              <Plus size={16} />
              <span className="hidden sm:inline">New shoot</span>
              <span className="sm:hidden sr-only">New shoot</span>
            </button>
          ) : null
        }
      />
      <div className="pl-scroll flex-1 min-h-0">
        <div className="max-w-2xl mx-auto px-4 py-4">
          {adding && (
            <NewShoot
              onDone={() => {
                setAdding(false);
                void mutate();
              }}
            />
          )}
          <div className="mb-4 flex gap-1" role="tablist" aria-label="Shoots">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={`h-10 px-3.5 rounded-full text-[13px] font-semibold ${view === v.key ? "bg-indigo text-white" : "bg-muted text-ink-2"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
          {!data ? (
            error ? (
              <div role="alert">
                <p className="text-[14px] text-ink-2">Couldn&apos;t load shoots — nothing is lost. {describeError(error)}</p>
                <button type="button" className={`${btnGhost} mt-3`} onClick={() => void mutate()}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="space-y-3" role="status" aria-label="Loading shoots">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            )
          ) : data.shoots.length === 0 ? (
            <p className="text-[14px] text-ink-3">
              {view === "mine" ? "No shoots assigned to you." : view === "past" ? "No past shoots." : "No shoots coming up."}
            </p>
          ) : (
            <ul className="space-y-2.5">
              {data.shoots.map((s) => (
                <ShootCard key={`${s.id}:${s.rev}`} s={s} onChanged={() => void mutate()} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
