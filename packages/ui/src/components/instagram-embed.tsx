"use client";
import * as React from "react";
import { cn } from "../lib/utils";

const IG_ORIGIN = "https://www.instagram.com";
const DEFAULT_HEIGHT = 560;

export interface InstagramEmbedProps {
  /** A framable `/embed/` URL — build it with `instagramEmbedUrl` from @dashmani/shared. */
  src: string;
  /** Accessible name for the frame. */
  title?: string;
  className?: string;
}

/**
 * Plays an Instagram post / reel in place through Instagram's own `/embed/` page.
 *
 * The frame sizes itself: the embed page posts `{"type":"MEASURE","details":{"height":N}}`
 * to its parent once laid out (and again when the caption expands). We only trust that
 * message from Instagram's origin AND from this frame's own window, so two players on
 * one page never resize each other. Until it arrives the frame sits at a reel-shaped
 * default height.
 *
 * Mount it on demand (behind a click), not in every row: each frame loads Instagram's
 * player, scripts and video.
 */
export function InstagramEmbed({ src, title = "Instagram post", className }: InstagramEmbedProps) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(DEFAULT_HEIGHT);

  React.useEffect(() => {
    setHeight(DEFAULT_HEIGHT);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== IG_ORIGIN || e.source !== ref.current?.contentWindow) return;
      let msg: any = e.data;
      if (typeof msg === "string") {
        try { msg = JSON.parse(msg); } catch { return; }
      }
      const h = Number(msg?.type === "MEASURE" ? msg.details?.height : NaN);
      if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.round(h), 200), 1200));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);

  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      height={height}
      loading="lazy"
      scrolling="no"
      allow="autoplay; encrypted-media; picture-in-picture; clipboard-write"
      allowFullScreen
      className={cn("block w-full max-w-[400px] rounded-lg border-0 bg-white", className)}
      style={{ height }}
    />
  );
}
