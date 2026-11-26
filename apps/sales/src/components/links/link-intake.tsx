"use client";
import { useMemo, useRef, useState } from "react";
import { linkAnalytics } from "@dashmani/shared";

// The paste box + TXT/CSV upload used by "New batch" and "Add links". The file is read IN THE
// BROWSER and sent as text — nothing is uploaded to the server's disk. The counts shown here come
// from the same parser the API uses, so they match what the batch will store.

const { splitEntries, intake, LINK_LIMITS } = linkAnalytics;

export interface IntakeValue {
  text: string;
  mode: "paste" | "csv";
  fileName: string | null;
}

export function useIntakeCounts(v: IntakeValue, keepDuplicates: boolean) {
  return useMemo(() => {
    const entries = splitEntries(v.text, v.mode);
    if (entries.length > LINK_LIMITS.maxEntriesPerAdd) return { counts: null, tooMany: entries.length, invalidSamples: [] as Array<{ raw: string; reason: string | null }> };
    const r = intake(entries, { keepDuplicates });
    return { counts: r.counts, tooMany: 0, invalidSamples: r.entries.filter((e) => e.validity === "invalid").slice(0, 5).map((e) => ({ raw: e.raw, reason: e.reason })) };
  }, [v.text, v.mode, keepDuplicates]);
}

export function LinkIntake({ value, onChange, keepDuplicates }: { value: IntakeValue; onChange: (v: IntakeValue) => void; keepDuplicates: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const { counts, tooMany, invalidSamples } = useIntakeCounts(value, keepDuplicates);

  async function readFile(f: File) {
    setFileError(null);
    if (f.size > LINK_LIMITS.maxUploadBytes) return setFileError("That file is larger than 2 MB. Split it into smaller files.");
    if (!/\.(txt|csv)$/i.test(f.name)) return setFileError("Upload a .txt or .csv file.");
    const text = await f.text();
    onChange({ text, mode: /\.csv$/i.test(f.name) ? "csv" : "paste", fileName: f.name });
  }

  return (
    <div className="min-w-0">
      <label className="block min-w-0">
        <span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">Post, reel or video links — one per line</span>
        <textarea
          className="input w-full min-h-[180px] font-mono text-xs"
          placeholder={"https://www.instagram.com/reel/…\nhttps://www.facebook.com/…/posts/…"}
          value={value.fileName ? "" : value.text}
          disabled={Boolean(value.fileName)}
          onChange={(e) => onChange({ text: e.target.value, mode: "paste", fileName: null })}
          aria-describedby="intake-counts"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <input ref={fileRef} type="file" accept=".txt,.csv,text/plain,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ""; }} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>Upload TXT or CSV</button>
        {value.fileName && (
          <span className="text-xs text-ink-3">
            {value.fileName} <button type="button" className="underline ml-1" onClick={() => onChange({ text: "", mode: "paste", fileName: null })}>Remove</button>
          </span>
        )}
        {fileError && <span className="text-xs text-danger" role="alert">{fileError}</span>}
      </div>
      <div id="intake-counts" className="mt-3 text-xs text-ink-3" aria-live="polite">
        {tooMany ? (
          <span className="text-danger">{tooMany.toLocaleString("en-IN")} links — at most {LINK_LIMITS.maxEntriesPerAdd.toLocaleString("en-IN")} at a time. Split them into several adds.</span>
        ) : counts && counts.total ? (
          <span>
            <b className="text-white">{counts.total}</b> total · <b className="text-success">{counts.valid}</b> valid · <b className={counts.invalid ? "text-danger" : ""}>{counts.invalid}</b> invalid · {counts.unique} unique · {counts.duplicate} duplicate{counts.duplicate === 1 ? "" : "s"}{keepDuplicates ? " (kept)" : " (skipped)"}
          </span>
        ) : (
          <span>Nothing pasted yet.</span>
        )}
        {invalidSamples.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {invalidSamples.map((s, i) => <li key={i} className="break-all"><span className="text-danger">✕</span> {s.raw.slice(0, 80)} — {s.reason}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
