"use client";
/**
 * The @-mention picker (spec §9.6): portalled and fixed above the composer, max 40vh,
 * 48 px rows, z-56, an ARIA listbox driven by aria-activedescendant on the textarea.
 * Filtering is local (zero requests per keystroke); duplicate names show their team hint.
 */
import { useEffect, useState } from "react";
import type { PipelineDirectoryEntry } from "@dashmani/shared";
import { ModalPortal } from "@/components/modal-portal";
import { Initials } from "../ui/Initials";
import { Z } from "../constants";

export function MentionPopover({
  anchor,
  listboxId,
  options,
  active,
  failed,
  loading,
  onPick,
  onRetry,
  onHover,
}: {
  anchor: HTMLElement | null;
  listboxId: string;
  options: PipelineDirectoryEntry[];
  active: number;
  failed: boolean;
  loading: boolean;
  onPick: (d: PipelineDirectoryEntry) => void;
  onRetry: () => void;
  onHover: (i: number) => void;
}) {
  const [box, setBox] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const vvTop = window.visualViewport?.offsetTop ?? 0;
      setBox({ top: r.top - 8, left: r.left, width: r.width, maxH: Math.max(96, Math.min(window.innerHeight * 0.4, r.top - vvTop - 16)) });
    };
    place();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    return () => {
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  if (!box) return null;
  return (
    <ModalPortal>
      <div
        className="fixed rounded-xl border border-rule bg-surface shadow-pop overflow-hidden"
        style={{ zIndex: Z.mention, top: box.top, left: box.left, width: box.width, transform: "translateY(-100%)" }}
      >
        {failed ? (
          <div className="flex items-center gap-2 px-3 h-12 text-[13px] text-ink-3" role="alert">
            Couldn&apos;t load people ·
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onRetry} className="h-11 px-2 font-semibold text-indigo underline">
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="px-3 h-12 flex items-center text-[13px] text-ink-4" role="status">
            Loading people…
          </div>
        ) : (
          <ul id={listboxId} role="listbox" aria-label="Mention someone" className="pl-scroll" style={{ maxHeight: box.maxH }}>
            {options.length === 0 ? (
              <li className="px-3 h-12 flex items-center text-[13px] text-ink-4" role="option" aria-selected={false} aria-disabled>
                No one matches that name
              </li>
            ) : (
              options.map((d, i) => (
                <li
                  key={d.id}
                  id={`${listboxId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(d)}
                  className={`h-12 flex items-center gap-2.5 px-3 cursor-pointer ${i === active ? "bg-indigo-soft" : ""}`}
                >
                  <Initials userId={d.id} name={d.name} initials={d.initials} size={28} />
                  <span className="pl-name min-w-0 flex-1 truncate text-[14px] text-ink">{d.name}</span>
                  {d.hint && <span className="min-w-0 max-w-[45%] truncate text-[12px] text-ink-4">{d.hint}</span>}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </ModalPortal>
  );
}
