"use client";
/**
 * Work on one project (2026-11-02): versions, review and approval, and one publishing record
 * per page. Rules live in packages/shared/src/pipeline/work.ts; the API enforces them.
 *
 *   - A version is a LINK to the file (NAS, Drive…) — nothing is uploaded here.
 *   - "Ask for review" pins the newest version of every kind. A newer version makes the review
 *     outdated, so an approval never carries over to a file the reviewer did not see.
 *   - A page can be marked Scheduled or Published only under the current approval (when the
 *     project has versions), and Published needs the live link.
 *
 * Data: GET /pipeline/projects/:id/work, fetched on mount and on focus (no polling) and after
 * every action here. Errors are worded by describeError — never a raw server message.
 */
import { useId, useState } from "react";
import useSWR from "swr";
import { ExternalLink } from "lucide-react";
import { pipelineWork as W } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, isApiError, plApi } from "../api";
import { PeoplePicker } from "./PeoplePicker";
import { Skeleton } from "../ui/Skeleton";

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo";
const btn = "h-11 px-3.5 rounded-xl text-[13px] font-semibold disabled:opacity-50";
const btnPrimary = `${btn} bg-indigo text-white`;
const btnGhost = `${btn} border border-border text-ink-2 hover:bg-muted`;

const APPROVAL_TONE: Record<W.PipelineApprovalState, string> = {
  none: "bg-muted text-ink-2",
  in_review: "bg-attention-bg text-attention",
  changes_requested: "bg-danger-bg text-danger",
  approved: "bg-success-bg text-success",
  outdated: "bg-attention-bg text-attention",
};

const STATUS_TONE: Record<W.PipelineDeliverableStatus, string> = {
  draft: "bg-muted text-ink-2",
  ready: "bg-indigo-soft text-indigo-deep",
  scheduled: "bg-indigo-soft text-indigo",
  published: "bg-success-bg text-success",
  failed: "bg-danger-bg text-danger",
  needs_verification: "bg-attention-bg text-attention",
  cancelled: "bg-muted text-ink-4 line-through",
};

/** "Tue, 4 Nov, 6:30 pm" in the viewer's time zone (India for every user today). */
function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${day}, ${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

/** datetime-local value (local time, minutes) ⇄ ISO. */
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

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="px-4 py-4 border-b border-rule">
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-3">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Err({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="mt-2 text-[13px] text-danger">
      {text}
    </p>
  ) : null;
}

export function WorkPanel({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const { data, error, isLoading, mutate } = useSWR(`pl-work:${projectId}`, () => plApi.work(projectId), {
    ...PL_SWR,
    revalidateOnFocus: true,
  });

  if (!data) {
    if (error) {
      return (
        <div className="p-4" role="alert">
          <p className="text-[13.5px] text-ink-2">{describeError(error)}</p>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => void mutate()}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="p-4 space-y-3" role="status" aria-label={isLoading ? "Loading versions and pages" : undefined}>
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  const refresh = () => void mutate();
  return (
    <div>
      <ApprovalSection projectId={projectId} work={data} readOnly={readOnly} onChanged={refresh} />
      <VersionsSection projectId={projectId} work={data} readOnly={readOnly} onChanged={refresh} />
      <PagesSection projectId={projectId} work={data} readOnly={readOnly} onChanged={refresh} />
    </div>
  );
}

// ── Approval ───────────────────────────────────────────────────────────────────────

function versionName(work: W.PipelineWorkDto, id: string): string {
  const v = work.versions.find((x) => x.id === id);
  return v ? `${W.PIPELINE_VERSION_KIND_LABEL[v.kind]} v${v.number}` : "an earlier version";
}

function ApprovalSection({
  projectId,
  work,
  readOnly,
  onChanged,
}: {
  projectId: string;
  work: W.PipelineWorkDto;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { meId } = usePipeline();
  const [asking, setAsking] = useState(false);
  const [reviewer, setReviewer] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const noteId = useId();

  const head = work.approval.reviewId ? work.reviews.find((r) => r.id === work.approval.reviewId) ?? null : null;
  const mineToDecide = head && head.status === "pending" && !head.outdated && head.reviewer.id === meId ? head : null;

  const ask = async () => {
    if (!reviewer[0]) return setErr("Pick who should review.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.requestReview(projectId, { reviewerId: reviewer[0], message: message.trim() || undefined });
      setAsking(false);
      setReviewer([]);
      setMessage("");
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "approved" | "changes_requested") => {
    if (!mineToDecide) return;
    if (decision === "changes_requested" && !note.trim()) return setErr("Say what needs to change.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.decideReview(mineToDecide.id, { decision, note: note.trim() || undefined });
      setNote("");
      onChanged();
    } catch (e) {
      setErr(describeError(e));
      if (isApiError(e) && (e.code === "REVIEW_OUTDATED" || e.code === "REVIEW_CLOSED")) onChanged();
    } finally {
      setBusy(false);
    }
  };

  const state = work.approval.state;
  let detail: string | null = null;
  if (head) {
    const covered = head.versionIds.map((id) => versionName(work, id)).join(", ");
    if (state === "approved") detail = `${head.reviewer.name} approved ${covered}.`;
    else if (state === "in_review") detail = `Waiting for ${head.reviewer.name} to review ${covered}.`;
    else if (state === "changes_requested") detail = `${head.reviewer.name} asked for changes to ${covered}.`;
    else if (state === "outdated") detail = `${head.reviewer.name}'s review covered ${covered}. A newer version was added since — ask for a new review.`;
  } else if (work.versions.length === 0) {
    detail = "Add a version below, then ask someone to review it.";
  }

  return (
    <Section title="Approval">
      <span className={`inline-flex items-center h-7 px-2.5 rounded-full text-[12.5px] font-semibold ${APPROVAL_TONE[state]}`}>
        {W.PIPELINE_APPROVAL_LABEL[state]}
      </span>
      {detail && <p className="mt-2 text-[13.5px] text-ink-2">{detail}</p>}
      {head?.note && (state === "changes_requested" || state === "approved") && (
        <p className="mt-2 text-[13.5px] text-ink whitespace-pre-wrap rounded-xl bg-muted px-3 py-2">{head.note}</p>
      )}

      {mineToDecide && !readOnly && (
        <div className="mt-3 space-y-2">
          <label htmlFor={noteId} className="block text-[12.5px] font-semibold text-ink-2">
            Your note <span className="text-ink-4 font-medium">(needed to ask for changes)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            maxLength={W.PIPELINE_WORK_LIMITS.reviewNoteMax}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void decide("approved")}>
              Approve
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => void decide("changes_requested")}>
              Request changes
            </button>
          </div>
        </div>
      )}

      {!readOnly && work.versions.length > 0 && !mineToDecide && (
        <div className="mt-3">
          {asking ? (
            <div className="space-y-2.5">
              <PeoplePicker value={reviewer} onChange={setReviewer} single exclude={[meId]} label="Reviewer" />
              <input
                className={inputCls}
                placeholder="Message (optional)"
                value={message}
                maxLength={W.PIPELINE_WORK_LIMITS.noteMax}
                onChange={(e) => setMessage(e.target.value)}
                aria-label="Message to the reviewer"
              />
              <div className="flex gap-2">
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => void ask()}>
                  Send for review
                </button>
                <button type="button" className={btnGhost} disabled={busy} onClick={() => setAsking(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={btnGhost} onClick={() => setAsking(true)}>
              {state === "none" ? "Ask for review" : "Ask for a new review"}
            </button>
          )}
        </div>
      )}
      <Err text={err} />
    </Section>
  );
}

// ── Versions ───────────────────────────────────────────────────────────────────────

function VersionsSection({
  projectId,
  work,
  readOnly,
  onChanged,
}: {
  projectId: string;
  work: W.PipelineWorkDto;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<W.PipelineVersionKind>("video");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [withUsage, setWithUsage] = useState(false);
  const [usage, setUsage] = useState<UsageForm>(() => usageFromVersion());

  const save = async () => {
    const input = {
      kind,
      url: url.trim() || null,
      body: kind === "caption" ? body : undefined,
      label: label.trim() || undefined,
      ...(withUsage ? usageToWire(usage) : {}),
    };
    const parsed = W.addVersionSchema.safeParse(input);
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.addVersion(projectId, parsed.data);
      setOpen(false);
      setUrl("");
      setBody("");
      setLabel("");
      setUsage(usageFromVersion());
      setWithUsage(false);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // Newest of each kind first, then older ones (the API sends kind asc, number desc).
  const latestIds = new Set(W.latestVersionIds(work.versions));
  const latest = work.versions.filter((v) => latestIds.has(v.id));
  const older = work.versions.filter((v) => !latestIds.has(v.id));

  return (
    <Section
      title="Versions"
      right={
        !readOnly && !open ? (
          <button type="button" className="text-[13px] font-semibold text-indigo h-11 px-1" onClick={() => setOpen(true)}>
            Add version
          </button>
        ) : null
      }
    >
      {open && (
        <div className="mb-3 space-y-2.5 rounded-xl border border-border p-3">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as W.PipelineVersionKind)} aria-label="Kind">
            {W.PIPELINE_VERSION_KINDS.map((k) => (
              <option key={k} value={k}>
                {W.PIPELINE_VERSION_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {kind === "caption" && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={W.PIPELINE_WORK_LIMITS.bodyMax}
              rows={4}
              placeholder="Caption text"
              aria-label="Caption text"
              className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
            />
          )}
          <input
            className={inputCls}
            type="url"
            inputMode="url"
            placeholder={kind === "caption" ? "Link (optional)" : "Link to the file — NAS, Drive…"}
            value={url}
            maxLength={W.PIPELINE_WORK_LIMITS.urlMax}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Link to the file"
          />
          <input
            className={inputCls}
            placeholder="Label (optional) — e.g. 9:16 cut"
            value={label}
            maxLength={W.PIPELINE_WORK_LIMITS.labelMax}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Label"
          />
          {withUsage ? (
            <UsageFields value={usage} onChange={setUsage} />
          ) : (
            <button type="button" className="h-9 text-[12.5px] font-semibold text-indigo" onClick={() => setWithUsage(true)}>
              Add usage &amp; rights (optional)
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              Save version
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <Err text={err} />
        </div>
      )}
      {work.versions.length === 0 && !open && <p className="text-[13.5px] text-ink-3">No versions yet.</p>}
      <ul className="space-y-2">
        {[...latest, ...(showAll ? older : [])].map((v) => (
          <VersionRow key={v.id} v={v} isLatest={latestIds.has(v.id)} readOnly={readOnly} onChanged={onChanged} />
        ))}
      </ul>
      {older.length > 0 && (
        <button type="button" className="mt-1 h-11 text-[13px] font-semibold text-ink-3" onClick={() => setShowAll((x) => !x)}>
          {showAll ? "Hide older versions" : `Show ${older.length} older version${older.length === 1 ? "" : "s"}`}
        </button>
      )}
    </Section>
  );
}

/** Usage facts as short badges; an active embargo or a lapsed licence is shown as a warning. */
function UsageBadges({ v }: { v: W.PipelineVersionDto }) {
  const today = toLocalInput(new Date().toISOString()).slice(0, 10);
  const embargoed = v.embargoUntil && Date.parse(v.embargoUntil) > Date.now();
  const expired = v.licenceExpires && v.licenceExpires < today;
  if (!v.rights && !v.source && !v.licenceExpires && !v.embargoUntil) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">
      {v.rights && <span className="px-2 py-0.5 rounded-full bg-muted text-ink-2">{W.PIPELINE_RIGHTS_LABEL[v.rights]}</span>}
      {v.source && <span className="px-2 py-0.5 rounded-full bg-muted text-ink-2 max-w-full truncate">Source: {v.source}</span>}
      {v.embargoUntil && (
        <span className={`px-2 py-0.5 rounded-full ${embargoed ? "bg-attention-bg text-attention font-semibold" : "bg-muted text-ink-3"}`}>
          {embargoed ? "Embargo until " : "Embargo ended "}
          {when(v.embargoUntil)}
        </span>
      )}
      {v.licenceExpires && (
        <span className={`px-2 py-0.5 rounded-full ${expired ? "bg-danger-bg text-danger font-semibold" : "bg-muted text-ink-3"}`}>
          {expired ? "Licence expired " : "Licence until "}
          {v.licenceExpires}
        </span>
      )}
    </div>
  );
}

type UsageForm = { rights: string; source: string; licenceExpires: string; embargoUntil: string; usageNotes: string };
const usageFromVersion = (v?: W.PipelineVersionDto): UsageForm => ({
  rights: v?.rights ?? "",
  source: v?.source ?? "",
  licenceExpires: v?.licenceExpires ?? "",
  embargoUntil: toLocalInput(v?.embargoUntil ?? null),
  usageNotes: v?.usageNotes ?? "",
});
const usageToWire = (f: UsageForm) => ({
  rights: f.rights as W.PipelineRights | "",
  source: f.source.trim(),
  licenceExpires: f.licenceExpires || null,
  embargoUntil: fromLocalInput(f.embargoUntil),
  usageNotes: f.usageNotes.trim(),
});

function UsageFields({ value, onChange }: { value: UsageForm; onChange: (f: UsageForm) => void }) {
  const set = (k: keyof UsageForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ ...value, [k]: e.target.value });
  return (
    <div className="space-y-2">
      <select className={inputCls} value={value.rights} onChange={set("rights")} aria-label="Rights">
        <option value="">Rights: not set</option>
        {W.PIPELINE_RIGHTS.map((r) => (
          <option key={r} value={r}>
            {W.PIPELINE_RIGHTS_LABEL[r]}
          </option>
        ))}
      </select>
      <input className={inputCls} placeholder="Source — creator, agency or our shoot" value={value.source} maxLength={W.PIPELINE_WORK_LIMITS.sourceMax} onChange={set("source")} aria-label="Source" />
      <label className="block text-[12.5px] font-semibold text-ink-2">
        Licence expires (last day it may be used)
        <input type="date" className={`${inputCls} mt-1`} value={value.licenceExpires} onChange={set("licenceExpires")} />
      </label>
      <label className="block text-[12.5px] font-semibold text-ink-2">
        Embargo — not before
        <input type="datetime-local" className={`${inputCls} mt-1`} value={value.embargoUntil} onChange={set("embargoUntil")} />
      </label>
      <textarea
        value={value.usageNotes}
        onChange={set("usageNotes")}
        maxLength={W.PIPELINE_WORK_LIMITS.usageNotesMax}
        rows={2}
        placeholder="Usage notes — where it may be used, exclusivity, credit line…"
        aria-label="Usage notes"
        className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
      />
    </div>
  );
}

function VersionRow({
  v,
  isLatest,
  readOnly,
  onChanged,
}: {
  v: W.PipelineVersionDto;
  isLatest: boolean;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [editUsage, setEditUsage] = useState(false);
  const [usage, setUsage] = useState<UsageForm>(() => usageFromVersion(v));
  const [showComments, setShowComments] = useState(v.comments.some((c) => !c.resolvedAt));
  const [comment, setComment] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = v.comments.filter((c) => !c.resolvedAt).length;

  const saveUsage = async () => {
    const parsed = W.editVersionUsageSchema.safeParse(usageToWire(usage));
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.editVersionUsage(v.id, parsed.data);
      setEditUsage(false);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const postComment = async () => {
    const atSeconds = at.trim() ? W.parseTimestamp(at) : null;
    if (at.trim() && atSeconds === null) return setErr("Write the time as 1:23 (minutes:seconds).");
    if (!comment.trim()) return setErr("Write a comment.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.addComment(v.id, { body: comment.trim(), atSeconds });
      setComment("");
      setAt("");
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleResolved = async (c: W.PipelineCommentDto) => {
    setBusy(true);
    setErr(null);
    try {
      await plApi.resolveComment(c.id, !c.resolvedAt);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`rounded-xl border px-3 py-2 min-w-0 ${isLatest ? "border-border" : "border-rule opacity-75"}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13.5px] font-bold text-ink shrink-0">
          {W.PIPELINE_VERSION_KIND_LABEL[v.kind]} v{v.number}
        </span>
        {v.label && <span className="min-w-0 truncate text-[13px] text-ink-3">{v.label}</span>}
        {v.url && (
          <a
            href={v.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 h-8 w-8 grid place-items-center rounded-lg text-indigo hover:bg-muted"
            aria-label={`Open ${W.PIPELINE_VERSION_KIND_LABEL[v.kind]} v${v.number}`}
          >
            <ExternalLink size={15} />
          </a>
        )}
      </div>
      {v.body && <p className="mt-1 text-[13px] text-ink-2 whitespace-pre-wrap break-words line-clamp-4">{v.body}</p>}
      <UsageBadges v={v} />
      {v.usageNotes && <p className="mt-1 text-[12.5px] text-ink-3 whitespace-pre-wrap break-words">{v.usageNotes}</p>}
      <p className="mt-1 text-[12px] text-ink-4">
        {v.createdBy.name} · {when(v.createdAt)}
      </p>

      <div className="mt-1 flex flex-wrap gap-x-3">
        <button type="button" className="h-9 text-[12.5px] font-semibold text-indigo" onClick={() => setShowComments((x) => !x)}>
          {showComments ? "Hide comments" : v.comments.length ? `Comments · ${open} open` : "Comment"}
        </button>
        {!readOnly && !editUsage && (
          <button type="button" className="h-9 text-[12.5px] font-semibold text-ink-3" onClick={() => setEditUsage(true)}>
            Usage &amp; rights
          </button>
        )}
      </div>

      {editUsage && (
        <div className="mt-2 space-y-2 rounded-xl border border-border p-2.5">
          <UsageFields value={usage} onChange={setUsage} />
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void saveUsage()}>
              Save
            </button>
            <button
              type="button"
              className={btnGhost}
              disabled={busy}
              onClick={() => {
                setUsage(usageFromVersion(v));
                setEditUsage(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {showComments && (
        <div className="mt-1.5">
          <ul className="space-y-1.5">
            {v.comments.map((c) => (
              <li key={c.id} className={`rounded-lg bg-muted/60 px-2.5 py-1.5 ${c.resolvedAt ? "opacity-60" : ""}`}>
                <p className="text-[13px] text-ink break-words whitespace-pre-wrap">
                  {c.atSeconds !== null && (
                    <span className="mr-1.5 font-mono text-[12px] font-semibold text-indigo">{W.formatTimestamp(c.atSeconds)}</span>
                  )}
                  <span className={c.resolvedAt ? "line-through" : ""}>{c.body}</span>
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-4">
                  <span className="min-w-0 truncate">
                    {c.author.name} · {when(c.createdAt)}
                    {c.resolvedBy ? ` · resolved by ${c.resolvedBy.name}` : ""}
                  </span>
                  {!readOnly && (
                    <button type="button" className="ml-auto shrink-0 h-8 font-semibold text-indigo" disabled={busy} onClick={() => void toggleResolved(c)}>
                      {c.resolvedAt ? "Reopen" : "Resolve"}
                    </button>
                  )}
                </p>
              </li>
            ))}
          </ul>
          {!readOnly && (
            <div className="mt-2 flex gap-2">
              {(v.kind === "video" || v.kind === "other") && (
                <input
                  className="w-[84px] shrink-0 h-11 px-2.5 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
                  placeholder="1:23"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  aria-label="Time in the video (optional)"
                  inputMode="numeric"
                />
              )}
              <input
                className="min-w-0 flex-1 h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
                placeholder="Add a comment"
                value={comment}
                maxLength={W.PIPELINE_WORK_LIMITS.commentMax}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void postComment();
                }}
                aria-label="Comment"
              />
              <button type="button" className={`${btnPrimary} shrink-0`} disabled={busy} onClick={() => void postComment()}>
                Post
              </button>
            </div>
          )}
        </div>
      )}
      <Err text={err} />
    </li>
  );
}

// ── Pages (deliverables) ───────────────────────────────────────────────────────────

function PagesSection({
  projectId,
  work,
  readOnly,
  onChanged,
}: {
  projectId: string;
  work: W.PipelineWorkDto;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<W.PipelineDeliverablePlatform>("instagram");
  const [destination, setDestination] = useState("");
  const [assignee, setAssignee] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!destination.trim()) return setErr("Name the page or account.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.addDeliverable(projectId, { platform, destination: destination.trim(), assigneeId: assignee[0] ?? null });
      setOpen(false);
      setDestination("");
      setAssignee([]);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const live = work.deliverables.filter((d) => d.status === "published").length;
  const total = work.deliverables.filter((d) => d.status !== "cancelled").length;

  return (
    <Section
      title={total > 0 ? `Pages · ${live} of ${total} live` : "Pages"}
      right={
        !readOnly && !open ? (
          <button type="button" className="text-[13px] font-semibold text-indigo h-11 px-1" onClick={() => setOpen(true)}>
            Add page
          </button>
        ) : null
      }
    >
      {open && (
        <div className="mb-3 space-y-2.5 rounded-xl border border-border p-3">
          <select
            className={inputCls}
            value={platform}
            onChange={(e) => setPlatform(e.target.value as W.PipelineDeliverablePlatform)}
            aria-label="Platform"
          >
            {W.PIPELINE_DELIVERABLE_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {W.PIPELINE_PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
          <input
            className={inputCls}
            placeholder="Page or account, e.g. @bollywoodsociety"
            value={destination}
            maxLength={W.PIPELINE_WORK_LIMITS.destinationMax}
            onChange={(e) => setDestination(e.target.value)}
            aria-label="Page or account"
          />
          <PeoplePicker value={assignee} onChange={setAssignee} single label="Who posts it (optional)" />
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void add()}>
              Add page
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <Err text={err} />
        </div>
      )}
      {work.deliverables.length === 0 && !open && (
        <p className="text-[13.5px] text-ink-3">Add each page or account this will be posted on — each gets its own status and live link.</p>
      )}
      <ul className="space-y-2">
        {work.deliverables.map((d) => (
          <PageRow key={`${d.id}:${d.rev}`} d={d} readOnly={readOnly} approval={work.approval} hasVersions={work.versions.length > 0} onChanged={onChanged} />
        ))}
      </ul>
    </Section>
  );
}

function PageRow({
  d,
  readOnly,
  approval,
  hasVersions,
  onChanged,
}: {
  d: W.PipelineDeliverableDto;
  readOnly: boolean;
  approval: W.PipelineApprovalSummary;
  hasVersions: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<W.PipelineDeliverableStatus>(d.status);
  const [liveUrl, setLiveUrl] = useState(d.liveUrl ?? "");
  const [at, setAt] = useState(toLocalInput(d.scheduledAt));
  const [caption, setCaption] = useState(d.caption);
  const [assignee, setAssignee] = useState<string[]>(d.assignee ? [d.assignee.id] : []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsApproval = hasVersions && W.PIPELINE_STATUSES_NEEDING_APPROVAL.includes(status) && !approval.approvedReviewId;

  const save = async () => {
    const changes: W.EditDeliverableInput["changes"] = {};
    if (status !== d.status) changes.status = status;
    const url = liveUrl.trim() || null;
    if (url !== d.liveUrl) changes.liveUrl = url;
    const iso = fromLocalInput(at);
    if (iso !== d.scheduledAt) changes.scheduledAt = iso;
    if (caption !== d.caption) changes.caption = caption;
    const a = assignee[0] ?? null;
    if (a !== (d.assignee?.id ?? null)) changes.assigneeId = a;
    if (Object.keys(changes).length === 0) return setEditing(false);
    const parsed = W.editDeliverableSchema.safeParse({ base: d.rev, changes });
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.editDeliverable(d.id, parsed.data);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
      if (isApiError(e) && e.code === "DELIVERABLE_CONFLICT") onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove ${d.destination} from this project?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await plApi.deleteDeliverable(d.id);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-border px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-[12px] font-semibold text-ink-3">{W.PIPELINE_PLATFORM_LABEL[d.platform]}</span>
        <span className="min-w-0 truncate text-[13.5px] font-bold text-ink" title={d.destination}>
          {d.destination}
        </span>
        <span className={`ml-auto shrink-0 inline-flex items-center h-6 px-2 rounded-full text-[11.5px] font-semibold ${STATUS_TONE[d.status]}`}>
          {W.PIPELINE_DELIVERABLE_STATUS_LABEL[d.status]}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        {d.assignee ? `Posts: ${d.assignee.name}` : "No one assigned"}
        {d.scheduledAt && d.status !== "published" ? ` · Goes live ${when(d.scheduledAt)}` : ""}
        {d.publishedAt ? ` · Live ${when(d.publishedAt)}${d.publishedBy ? ` by ${d.publishedBy.name}` : ""}` : ""}
      </p>
      {d.liveUrl && (
        <a href={d.liveUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate text-[13px] text-indigo underline">
          {d.liveUrl}
        </a>
      )}

      {editing ? (
        <div className="mt-2.5 space-y-2.5">
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as W.PipelineDeliverableStatus)} aria-label="Status">
            {W.PIPELINE_DELIVERABLE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {W.PIPELINE_DELIVERABLE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {needsApproval && (
            <p className="text-[12.5px] text-attention bg-attention-bg rounded-lg px-2.5 py-1.5">
              The newest versions aren&apos;t approved yet, so this can&apos;t be scheduled or published.
            </p>
          )}
          <label className="block text-[12.5px] font-semibold text-ink-2">
            Goes live at
            <input type="datetime-local" className={`${inputCls} mt-1`} value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
          <input
            className={inputCls}
            type="url"
            inputMode="url"
            placeholder="Live link (needed for Published)"
            value={liveUrl}
            maxLength={W.PIPELINE_WORK_LIMITS.urlMax}
            onChange={(e) => setLiveUrl(e.target.value)}
            aria-label="Live link"
          />
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={W.PIPELINE_WORK_LIMITS.bodyMax}
            rows={3}
            placeholder="Caption for this page (optional)"
            aria-label="Caption for this page"
            className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
          />
          <PeoplePicker value={assignee} onChange={setAssignee} single label="Who posts it" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy || needsApproval} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {d.status !== "published" && (
              <button type="button" className={`${btn} ml-auto text-danger`} disabled={busy} onClick={() => void remove()}>
                Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        !readOnly && (
          <button type="button" className="mt-1 h-11 text-[13px] font-semibold text-indigo" onClick={() => setEditing(true)}>
            Update
          </button>
        )
      )}
      <Err text={err} />
    </li>
  );
}
