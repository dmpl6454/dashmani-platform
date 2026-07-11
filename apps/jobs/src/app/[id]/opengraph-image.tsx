// Dynamic Open Graph preview image for each role page.
//
// Next's file-convention: this route auto-wires og:image + twitter:image for
// /[slug], so a shared link (e.g. jobs.digitalsukoon.com/revenue-head) shows a
// branded 1200×630 card — role title, department, meta — in WhatsApp/LinkedIn/etc.
// instead of a bare link with no image.
//
// Edge runtime: the Node build of @vercel/og has a Windows-only path bug loading
// its bundled default font; edge inlines the font and renders identically on
// Linux/production, so we use it here.

import { ImageResponse } from "next/og";
import { resolveJob, SITE_URL } from "@/lib/jobs";
import { getDeptColor } from "@/lib/dept-colors";

export const runtime = "edge";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Digital Sukoon Careers — open role";

const TYPE_DISPLAY: Record<string, string> = {
  FULL_TIME: "Full-time", PART_TIME: "Part-time", CONTRACT: "Contract",
  INTERNSHIP: "Internship", FREELANCE: "Freelance",
};

const INK = "#0B0F3A";
const PAPER = "#FBFAF7";
const MUTED = "#5B6178";

// Brand font, self-hosted under /public/fonts and fetched over HTTP so it works in
// the edge runtime (no fs). Falls back to the built-in font if the fetch fails.
async function loadFonts(origin: string) {
  try {
    const [regular, bold] = await Promise.all([
      fetch(`${origin}/fonts/InstagramSans-Regular.woff`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())),
      fetch(`${origin}/fonts/InstagramSans-Bold.woff`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())),
    ]);
    return [
      { name: "ISans", data: regular, weight: 400 as const, style: "normal" as const },
      { name: "ISans", data: bold, weight: 700 as const, style: "normal" as const },
    ];
  } catch {
    return undefined; // let @vercel/og use its default font
  }
}

export default async function Image({ params }: { params: { id: string } }) {
  const job = await resolveJob(params.id);
  const fonts = await loadFonts(SITE_URL);
  const fontFamily = fonts ? "ISans" : "sans-serif";
  const opts = { ...size, ...(fonts ? { fonts } : {}) };

  // No such role → a clean generic careers card rather than a broken image.
  if (!job) {
    return new ImageResponse(
      (
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: PAPER, color: INK, fontFamily }}>
          <div style={{ display: "flex", fontSize: 30, letterSpacing: 4, color: MUTED }}>DIGITAL SUKOON</div>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 700, marginTop: 16 }}>Careers</div>
        </div>
      ),
      opts,
    );
  }

  const accent = getDeptColor(job.department);
  const metaParts = [TYPE_DISPLAY[job.type] || job.type, job.location, job.experience].filter(Boolean) as string[];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: PAPER,
          color: INK,
          fontFamily,
        }}
      >
        {/* Department accent stripe across the top */}
        <div style={{ display: "flex", height: 16, width: "100%", background: accent }} />

        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "72px 80px", justifyContent: "space-between" }}>
          {/* Eyebrow row: department · branding */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", width: 16, height: 16, borderRadius: 8, background: accent }} />
              <div style={{ display: "flex", fontSize: 28, fontWeight: 700, letterSpacing: 3, color: accent, textTransform: "uppercase" }}>
                {job.department || "Open Role"}
              </div>
            </div>
            <div style={{ display: "flex", fontSize: 24, letterSpacing: 3, color: MUTED }}>DIGITAL SUKOON</div>
          </div>

          {/* Title + meta */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: job.title.length > 22 ? 82 : 104, fontWeight: 700, lineHeight: 1.02, letterSpacing: -1 }}>
              {job.title}
            </div>
            {metaParts.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 30, fontSize: 32, color: MUTED }}>
                {metaParts.map((part, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 18 }}>
                    {i > 0 && <div style={{ display: "flex", width: 6, height: 6, borderRadius: 3, background: MUTED }} />}
                    <div style={{ display: "flex" }}>{part}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer: url + apply pill */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", fontSize: 26, color: MUTED }}>jobs.digitalsukoon.com</div>
            <div style={{ display: "flex", alignItems: "center", background: INK, color: PAPER, padding: "16px 30px", borderRadius: 999, fontSize: 28, fontWeight: 700 }}>
              Apply now  →
            </div>
          </div>
        </div>
      </div>
    ),
    opts,
  );
}
