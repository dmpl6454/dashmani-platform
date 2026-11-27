"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, apiFetchBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";

// The signature printed above the signatory's name on invoices and credit notes. Uploading
// stores the image and puts its id in the form; it reaches documents when the profile is saved.
// Invoices already issued keep the signature they were issued with.

const MAX_BYTES = 300 * 1024;

function typeOf(file: File): "image/png" | "image/jpeg" | null {
  if (file.type === "image/png" || /\.png$/i.test(file.name)) return "image/png";
  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) return "image/jpeg";
  return null;
}

export function SignatureField({ company, signatureId, printSignature, savedId, onChange, onPrintChange }: {
  company: string;
  signatureId: string | null;
  printSignature: boolean;
  /** The id in the saved profile, to say when the form differs from what documents print. */
  savedId: string | null;
  onChange: (id: string | null) => void;
  onPrintChange: (on: boolean) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreviewError(false);
    if (!signatureId) { setUrl(null); return; }
    let live = true;
    let made: string | null = null;
    apiFetchBlob(`/sales/settings/signature/${signatureId}`)
      .then(({ blob }) => { if (!live) return; made = URL.createObjectURL(blob); setUrl(made); })
      .catch(() => { if (live) { setUrl(null); setPreviewError(true); } });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [signatureId]);

  async function upload(file: File) {
    setError(null);
    const type = typeOf(file);
    if (!type) { setError("Upload the signature as a PNG or JPEG image."); return; }
    if (file.size > MAX_BYTES) { setError("That image is larger than 300 KB. Crop it to the signature, or save it smaller."); return; }
    setBusy(true);
    try {
      const r = await apiFetch<{ signatureId: string }>(`/sales/settings/signature?company=${company}`, { method: "POST", body: file, headers: { "Content-Type": type } });
      onChange(r.data.signatureId);
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const unsaved = (signatureId ?? null) !== (savedId ?? null);
  return (
    <div className="sm:col-span-2 min-w-0">
      <span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">Signature</span>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-[180px] h-[64px] bg-white border border-border flex items-center justify-center p-1 shrink-0" aria-live="polite">
          {url ? <img src={url} alt="Signature printed on invoices" className="max-w-full max-h-full object-contain" />
            : <span className="text-xs text-neutral-500 text-center px-2">{previewError ? "Couldn't load the image" : signatureId ? "Loading…" : "No signature"}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="sr-only" id="signature-file"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : signatureId ? "Replace" : "Upload signature"}
          </button>
          {signatureId && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setError(null); onChange(null); }}>Remove</button>}
        </div>
      </div>
      <label className="flex items-center gap-2 mt-3 text-sm">
        <input type="checkbox" checked={printSignature} disabled={!signatureId} onChange={(e) => onPrintChange(e.target.checked)} />
        Print the signature on invoices and credit notes
      </label>
      {error && <p className="text-sm text-danger mt-2" role="alert">{error}</p>}
      <span className="block text-xs text-ink-4 mt-1">
        PNG or JPEG, up to 300 KB. A signature (or signature and seal) on a white or transparent background prints best.
        {unsaved ? " Click Save to apply it." : " Invoices already issued keep the signature they were issued with."}
      </span>
    </div>
  );
}
