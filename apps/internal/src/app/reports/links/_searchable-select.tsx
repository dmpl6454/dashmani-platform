"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

/**
 * A select with a search box — for lists too long to scroll (≈120 people, ≈450 channels)
 * and whose labels repeat (two people share a name; many channels share a display name),
 * so every option carries a second line (team · platform · @handle) that is searched too.
 *
 * Keyed by VALUE (an id), never by label, so a duplicate name can never select the wrong
 * row. The first option is always "All …" (value ""). Keyboard: ↑/↓, Enter, Esc, Tab.
 * Inputs are 16px (text-base) so iOS Safari does not zoom on focus.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** Second line — also matched by the search. */
  detail?: string;
}

const RENDER_LIMIT = 200;

export function SearchableSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
  searchPlaceholder,
  staleLabel,
}: {
  label: string;
  allLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  searchPlaceholder: string;
  /** Shown when `value` is set but is no longer among the options (it left the current scope). */
  staleLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const selected = value ? options.find((o) => o.value === value) ?? null : null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const items = useMemo<SelectOption[]>(
    () => [{ value: "", label: allLabel }, ...matches.slice(0, RENDER_LIMIT)],
    [matches, allLabel],
  );
  const matchCount = matches.length;

  // On open: focus the search box and highlight the current value.
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    inputRef.current?.focus();
    // Deliberately keyed on `open` alone: this runs when the popover opens, not on every
    // keystroke (which would keep resetting the highlight).
  }, [open]);

  // Close on a press outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Focus stays in the search box, so the browser will not scroll the highlighted option
  // into view by itself.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function close(focusButton: boolean) {
    setOpen(false);
    setQuery("");
    if (focusButton) buttonRef.current?.focus();
  }

  function choose(v: string) {
    onChange(v);
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = items[active];
      if (o) choose(o.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  const triggerText = selected ? selected.label : value ? staleLabel ?? "Selected" : allLabel;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${triggerText}`}
        title={selected?.detail ? `${selected.label} · ${selected.detail}` : triggerText}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-white px-3 text-left text-base focus:outline-none focus:ring-2 focus:ring-[#F5D547] ${
          value ? "border-ink/30 text-ink" : "border-ink/10 text-ink"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{triggerText}</span>
        <ChevronDown className="h-4 w-4 flex-none text-ink-4" aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-0 overflow-hidden rounded-xl border border-ink/10 bg-white shadow-lg">
          <div className="relative border-b border-ink/10 p-2">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={`Search ${label.toLowerCase()}`}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items[active] ? `${baseId}-opt-${active}` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full min-w-0 rounded-lg border border-ink/10 bg-white pl-8 pr-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
            />
          </div>
          <ul id={listId} ref={listRef} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
            {items.map((o, i) => (
              <li
                key={o.value || "__all"}
                id={`${baseId}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                // Keep focus in the search box, so a tap selects instead of blurring first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.value)}
                className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${i === active ? "bg-ink/5" : ""}`}
              >
                <Check className={`mt-0.5 h-4 w-4 flex-none ${o.value === value ? "text-indigo" : "invisible"}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${o.value === "" ? "font-medium text-ink" : "text-ink"}`}>{o.label}</span>
                  {o.detail && <span className="block truncate text-xs text-ink-4">{o.detail}</span>}
                </span>
              </li>
            ))}
            {matchCount === 0 && query.trim() !== "" && (
              <li className="px-3 py-2 text-xs text-ink-4 break-words">No match for “{query.trim()}”.</li>
            )}
          </ul>
          {matchCount > RENDER_LIMIT && (
            <p className="border-t border-ink/10 px-3 py-2 text-[11px] text-ink-4">
              Showing the first {RENDER_LIMIT} of {matchCount} — keep typing to narrow.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
