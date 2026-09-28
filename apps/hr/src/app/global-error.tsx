"use client";
/** Last-resort boundary (spec §9.9). Replaces the root layout, so it renders <html>. */
import { useEffect } from "react";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";

export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadOnceForChunkError(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#FDFCF0", color: "#1A1A1A" }}>
        <div role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "64px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Something on this page failed to load.</p>
          <p style={{ fontSize: 13, color: "#6C6555", margin: 0 }}>Your drafts are saved.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ height: 44, padding: "0 20px", borderRadius: 12, border: 0, background: "#1A1A1A", color: "#fff", fontSize: 13, fontWeight: 600 }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
