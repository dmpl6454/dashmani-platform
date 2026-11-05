"use client";
// One square-cornered file input that uploads as soon as a file is chosen. On
// WARNINGS_NOT_ACCEPTED the sentences show with "Upload anyway", which re-posts with
// acceptWarnings=true (spec-reconcile §7.3).
import { useRef, useState } from "react";
import { ApiError, apiUpload } from "@/lib/api";
import { errorSentence } from "@/lib/messages";

export function UploadFile<T>({ path, accept, fields, busyLabel, hint, disabled, onDone, onError }: {
  path: string; accept: string; fields: Record<string, string>; busyLabel: string; hint: string; disabled?: boolean;
  onDone: (data: T) => void; onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ file: File; warning: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const send = async (file: File, acceptWarnings: boolean) => {
    setBusy(true);
    try {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      if (acceptWarnings) form.append("acceptWarnings", "true");
      form.append("file", file);
      const r = await apiUpload<T>(path, form);
      setPending(null);
      onDone(r.data);
    } catch (err) {
      if (err instanceof ApiError && err.code === "WARNINGS_NOT_ACCEPTED") setPending({ file, warning: err.message });
      else onError(errorSentence(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="mb-4 min-w-0">
      <label className="block">
        <span className="sr-only">Choose a file to upload</span>
        <input ref={input} type="file" accept={accept} disabled={busy || disabled} className="block w-full text-sm border-2 border-border p-2 file:mr-3 file:border-0 file:bg-indigo file:text-white file:px-3 file:py-1.5"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void send(f, false); }} />
      </label>
      <p className="text-xs text-ink-3 mt-1">{busy ? busyLabel : hint}</p>
      {pending && (
        <div className="card border-attention p-3 text-sm mt-2" role="alert">
          <p className="mb-2">{pending.warning}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => send(pending.file, true)}>{busy ? busyLabel : "Upload anyway"}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
