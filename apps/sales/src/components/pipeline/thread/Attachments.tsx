"use client";
/**
 * Files attached to a chat message (2026-11-23), drawn under the message text like WhatsApp:
 * a photo as a preview (tap to view it full screen ON THE SAME PAGE — PhotoViewer, never a new
 * tab), any other file as a card with Open and Download. Each file is a project document (`#{file:<id>}` in the body, file-tokens.ts), so it
 * is also listed in the project's Documents tab and outlives the message.
 *
 * Data: GET /pipeline/documents/:id per file (SWR, cached per id). For a photo that answer also
 * carries `view`, a 15-minute signed link, so the preview needs no second request; GET …/file
 * refreshes it every 10 minutes while it is on screen, or at once if the image fails to load
 * (an expired link from the cache).
 */
import { memo, useState } from "react";
import useSWR from "swr";
import { Download, ExternalLink, FileText } from "lucide-react";
import { pipelineDocs as D, pipelineWork as W } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, isApiError, plApi } from "../api";
import { UploadError, openVersionFile } from "../upload";
import { PhotoViewer } from "../ui/PhotoViewer";

const LINK_REFRESH_MS = 10 * 60_000;

function Photo({ doc }: { doc: D.PipelineDocDto }) {
  const fresh = !!doc.view && Date.parse(doc.view.expiresAt) - Date.now() > 60_000;
  const { data, mutate } = useSWR(`pl-docfile:${doc.id}`, () => plApi.documentFile(doc.id, false), {
    ...PL_SWR,
    fallbackData: fresh ? doc.view : undefined,
    revalidateOnMount: !fresh,
    refreshInterval: LINK_REFRESH_MS,
  });
  const [retried, setRetried] = useState(false);
  const onImgError = () => {
    if (retried) return; // one fresh link per mount: a broken file must not loop
    setRetried(true);
    void mutate();
  };
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const download = async () => {
    setErr(null);
    try {
      await openVersionFile(() => plApi.documentFile(doc.id, true), true);
    } catch (e) {
      setErr(e instanceof UploadError ? e.message : describeError(e));
    }
  };
  return (
    <div>
      {viewing && data?.url && (
        <PhotoViewer url={data.url} name={doc.file?.name ?? doc.title} onDownload={() => void download()} onClose={() => setViewing(false)} />
      )}
      <button
        type="button"
        onClick={() => data?.url && setViewing(true)}
        className="block overflow-hidden border border-border bg-muted"
        aria-label={`Open ${doc.file?.name ?? doc.title}`}
      >
        {data?.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a signed R2 link, not a static asset
          <img src={data.url} alt={doc.title} loading="lazy" onError={onImgError} className="block max-h-64 max-w-[min(18rem,100%)] object-contain" />
        ) : (
          <span className="grid h-40 w-56 place-items-center text-[12.5px] text-ink-3">Loading photo…</span>
        )}
      </button>
      {err && <p className="mt-1 text-[12.5px] text-danger">{err}</p>}
    </div>
  );
}

function FileCard({ doc }: { doc: D.PipelineDocDto }) {
  const [err, setErr] = useState<string | null>(null);
  const open = async (download: boolean) => {
    setErr(null);
    try {
      await openVersionFile(() => plApi.documentFile(doc.id, download), download);
    } catch (e) {
      setErr(e instanceof UploadError ? e.message : describeError(e));
    }
  };
  return (
    <div className="max-w-[20rem] border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <FileText size={22} className="shrink-0 text-indigo" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-ink" title={doc.file?.name ?? doc.title}>
            {doc.file?.name ?? doc.title}
          </p>
          <p className="text-[12px] text-ink-3">
            {doc.file ? W.formatBytes(doc.file.size) : ""} · {D.PIPELINE_DOC_TYPE_LABEL[doc.type]}
          </p>
        </div>
      </div>
      <div className="mt-1.5 flex gap-3">
        <button type="button" className="inline-flex items-center gap-1 h-9 text-[13px] font-semibold text-indigo" onClick={() => void open(false)}>
          <ExternalLink size={13} aria-hidden /> Open
        </button>
        <button type="button" className="inline-flex items-center gap-1 h-9 text-[13px] font-semibold text-indigo" onClick={() => void open(true)}>
          <Download size={13} aria-hidden /> Download
        </button>
      </div>
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
    </div>
  );
}

function Attachment({ id }: { id: string }) {
  const { data, error } = useSWR(`pl-doc:${id}`, () => plApi.document(id), { ...PL_SWR, revalidateOnFocus: false });
  if (!data) {
    const gone = isApiError(error) && (error.status === 404 || error.code === "DOCUMENT_NOT_FOUND");
    return (
      <div className="max-w-[20rem] border border-dashed border-border px-3 py-2 text-[12.5px] text-ink-3">
        {gone ? "This file was removed from Documents." : error ? "Couldn't load this file." : "📎 Loading file…"}
      </div>
    );
  }
  if (data.file && D.isImageType(data.file.type)) return <Photo doc={data} />;
  return <FileCard doc={data} />;
}

function AttachmentsImpl({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {ids.map((id) => (
        <Attachment key={id} id={id} />
      ))}
    </div>
  );
}

export const Attachments = memo(AttachmentsImpl);
