"use client";
import { Icon } from "./portal-icons";
import type { Post } from "@/lib/portal-store";

/* Real Instagram post card — 1080×1350 4:5 portrait scaled to 320 wide. */
export function IGFeedCard({ post }: { post: Post }) {
  const hashtagText = (post.hashtags || []).join(" ");
  const mediaH =
    post.format === "REEL" ? Math.round(320 * 16 / 9)
    : post.aspect === "4:5" ? 400
    : post.aspect === "9:16" ? 568
    : 320;
  return (
    <div className="bg-surface border border-border rounded-lg w-[340px] shadow-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-12 border-b border-rule">
        <div className="h-7 w-7 rounded-full p-px" style={{ background: "linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)" }}>
          <div className="h-full w-full rounded-full bg-surface grid place-items-center text-[10px] font-bold">B</div>
        </div>
        <div className="flex-1 leading-tight">
          <div className="text-[12.5px] font-semibold">bombay.roastery</div>
          <div className="text-[10.5px] text-ink-3">Bombay · Sponsored</div>
        </div>
        <Icon.More size={18} className="text-ink-2"/>
      </div>
      <div className="ig-hatch relative" style={{ height: mediaH }}>
        {post.format === "REEL" && (
          <>
            <span className="absolute top-2 right-2 text-[10px] font-medium text-ink-3 bg-bg/85 px-1.5 py-0.5 rounded">
              Reel · {post.duration || "0:14"}
            </span>
            <div className="absolute inset-0 grid place-items-center">
              <div className="h-12 w-12 rounded-full bg-ink/15 backdrop-blur-sm grid place-items-center">
                <div className="play-glyph ml-1"/>
              </div>
            </div>
          </>
        )}
        {post.format === "CAROUSEL" && (
          <>
            <span className="absolute top-2 right-2 text-[10px] font-medium text-ink-3 bg-bg/85 px-1.5 py-0.5 rounded">1/8</span>
            <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <span key={i} className={`h-1.5 w-1.5 rounded-full ${i === 0 ? "bg-surface" : "bg-surface/40"}`}/>
              ))}
            </div>
          </>
        )}
        {post.format === "POST" && (
          <span className="absolute top-2 left-2 text-[10px] font-medium text-ink-3 bg-bg/85 px-1.5 py-0.5 rounded">{post.aspect || "1:1"}</span>
        )}
      </div>
      <div className="px-3 h-11 flex items-center gap-3 text-ink">
        <Icon.Heart size={22}/>
        <Icon.Comment size={22}/>
        <Icon.Share size={22}/>
        <div className="flex-1"/>
        <Icon.Bookmark size={22}/>
      </div>
      <div className="px-3 pb-3 text-[12.5px] leading-snug">
        <span className="font-semibold">bombay.roastery</span>{" "}
        <span className="text-ink-2 text-rowtight">{post.caption}</span>
        {hashtagText && <div className="text-ink-3 mt-1 text-rowtight">{hashtagText}</div>}
        <div className="text-[10.5px] text-ink-3 mt-1.5 uppercase tracking-wider">
          {post.scheduled ? new Date(post.scheduled).toLocaleDateString("en", { month: "long", day: "numeric" }).toUpperCase() : "DRAFT"}
        </div>
      </div>
    </div>
  );
}

export function IGProfileGrid({ post: _post }: { post: Post }) {
  const tiles = Array.from({ length: 9 }, (_, i) => i);
  const focusIndex = 4;
  return (
    <div className="bg-surface border border-border rounded-lg w-[340px] shadow-card overflow-hidden">
      <div className="flex items-center gap-3 px-3 h-14 border-b border-rule">
        <div className="h-10 w-10 rounded-full p-px" style={{ background: "linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)" }}>
          <div className="h-full w-full rounded-full bg-surface grid place-items-center text-[12px] font-bold">B</div>
        </div>
        <div className="flex-1 leading-tight">
          <div className="text-[13px] font-semibold">bombay.roastery</div>
          <div className="text-[11px] text-ink-3">8.2k followers · 384 posts</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px bg-rule">
        {tiles.map((i) => (
          <div key={i} className={`aspect-square ig-hatch relative ${i === focusIndex ? "ring-2 ring-action ring-inset" : ""}`}>
            {i === focusIndex && (
              <div className="absolute inset-0 grid place-items-center bg-action-soft/70">
                <span className="text-[10px] font-bold text-ink uppercase tracking-wider">This post</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="px-3 py-2 text-center text-[10.5px] text-ink-3 uppercase tracking-wider">future ↓ recent</div>
    </div>
  );
}

export function IGStory({ post }: { post: Post }) {
  return (
    <div className="bg-ink rounded-2xl overflow-hidden w-[280px] shadow-pop relative" style={{ aspectRatio: "9 / 16" }}>
      <div className="absolute top-0 inset-x-0 h-1 bg-surface/30 m-2 rounded-full overflow-hidden">
        <div className="h-full w-1/4 bg-surface rounded-full" />
      </div>
      <div className="absolute top-5 inset-x-0 flex items-center gap-2 px-3">
        <div className="h-7 w-7 rounded-full bg-surface grid place-items-center text-[10px] font-bold">B</div>
        <div className="text-[12px] font-semibold text-surface">bombay.roastery</div>
        <div className="text-[10.5px] text-surface/70">{post.scheduled ? "scheduled" : "now"}</div>
      </div>
      <div className="absolute inset-0 ig-hatch-dark"/>
      <div className="absolute bottom-4 inset-x-3 text-surface">
        <div className="text-[14px] font-medium leading-snug text-rowtight">{post.caption}</div>
      </div>
    </div>
  );
}
