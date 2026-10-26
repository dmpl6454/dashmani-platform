"use client";
import { useState, type ReactNode } from "react";
import { Play, X } from "lucide-react";
import { instagramEmbedUrl } from "@dashmani/shared/src/utils/instagram";
import { InstagramEmbed } from "@dashmani/ui";

/**
 * A link row that can play its Instagram post / reel in place. Renders `children` (the
 * existing row) with a play button beside it; the button opens Instagram's embed player
 * under the row. For any URL that is not an Instagram post it renders `children` as is.
 *
 * The player loads only on click, so a list of 20 reels costs nothing until one is opened.
 * `rowClassName` styles the flex row holding `children` and the button.
 */
export function InstagramInline({
  url, children, rowClassName = "flex items-center gap-2 min-w-0", buttonClassName = "",
}: {
  url: string | null | undefined;
  children: ReactNode;
  rowClassName?: string;
  buttonClassName?: string;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const src = instagramEmbedUrl(url);
  if (!src) return <>{children}</>;
  // Compare to the CURRENT src so a row whose url changes under it starts closed.
  const open = openFor === src;
  return (
    <div className="min-w-0">
      <div className={rowClassName}>
        <div className="flex-1 min-w-0">{children}</div>
        <button
          type="button"
          onClick={() => setOpenFor(open ? null : src)}
          aria-expanded={open}
          aria-label={open ? "Close Instagram player" : "Play on Instagram"}
          title={open ? "Close player" : "Play here"}
          className={`shrink-0 h-6 w-6 rounded-full grid place-items-center text-white bg-gradient-to-br from-[#F0803C] to-[#EC42B7] hover:opacity-90 transition-opacity ${buttonClassName}`}
        >
          {open ? <X className="h-3 w-3" /> : <Play className="h-3 w-3 translate-x-[1px]" fill="currentColor" />}
        </button>
      </div>
      {open && <InstagramEmbed src={src} className="mt-2 mx-auto" />}
    </div>
  );
}
