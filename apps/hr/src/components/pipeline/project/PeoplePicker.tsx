"use client";
/**
 * Pick people from the directory (spec §9.6–9.7): local filtering, pickable users only,
 * a team hint for duplicate names, and an honest "Couldn't load people · Retry" when the
 * directory failed — never an empty list that looks like "nobody exists".
 */
import { useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import { usePipeline } from "../provider";
import { Initials } from "../ui/Initials";
import { filterPeople } from "./people-filter";

export function PeoplePicker({
  value,
  onChange,
  exclude = [],
  prefer = [],
  max = 20,
  label = "People",
  single = false,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  exclude?: string[];
  prefer?: string[];
  max?: number;
  label?: string;
  /** Pick exactly one (owner transfer): selecting replaces. */
  single?: boolean;
}) {
  const { directory, directoryFailed, retryDirectory, dirById } = usePipeline();
  const [q, setQ] = useState("");
  const inputId = useId();
  const excl = useMemo(() => new Set([...exclude, ...value]), [exclude, value]);
  const pref = useMemo(() => new Set(prefer), [prefer]);
  const results = useMemo(
    () => (directory ? filterPeople(directory, q, { exclude: excl, prefer: pref, limit: 8 }) : []),
    [directory, q, excl, pref],
  );
  const full = !single && value.length >= max;

  return (
    <div>
      <label htmlFor={inputId} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
        {label}
        {!single && <span className="text-ink-4 font-medium"> · {value.length}/{max}</span>}
      </label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 mb-2">
          {value.map((id) => {
            const d = dirById.get(id);
            return (
              <li key={id} className="inline-flex items-center gap-1.5 h-11 pl-1.5 pr-0.5 rounded-full bg-muted max-w-full min-w-0">
                <Initials userId={id} name={d?.name} initials={d?.initials} size={28} />
                <span className="pl-name min-w-0 truncate text-[13px] font-medium text-ink">{d?.name ?? "Someone"}</span>
                <button
                  type="button"
                  aria-label={`Remove ${d?.name ?? "person"}`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                  className="h-10 w-10 grid place-items-center rounded-full text-ink-3 hover:bg-white"
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {directoryFailed ? (
        <div role="alert" className="flex items-center gap-2 text-[13px] text-ink-3">
          Couldn&apos;t load people ·
          <button type="button" onClick={retryDirectory} className="h-11 px-2 font-semibold text-indigo underline">
            Retry
          </button>
        </div>
      ) : !directory ? (
        <p className="text-[13px] text-ink-4" role="status">
          Loading people…
        </p>
      ) : (
        <>
          <input
            id={inputId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={full}
            placeholder={full ? `Up to ${max} people` : "Search by name"}
            autoComplete="off"
            className="w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-indigo disabled:opacity-60"
          />
          {!full && (
            <ul className="mt-1 max-h-60 pl-scroll rounded-xl" aria-label={`${label} results`}>
              {results.length === 0 ? (
                <li className="px-3 py-3 text-[13px] text-ink-4">{q ? "No one matches that name." : "No one else to add."}</li>
              ) : (
                results.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(single ? [d.id] : [...value, d.id]);
                        setQ("");
                      }}
                      className="w-full h-12 flex items-center gap-2.5 px-2 rounded-xl text-left hover:bg-muted"
                    >
                      <Initials userId={d.id} name={d.name} initials={d.initials} size={28} />
                      <span className="pl-name min-w-0 flex-1 truncate text-[14px] text-ink">{d.name}</span>
                      {d.hint && <span className="min-w-0 max-w-[40%] truncate text-[12px] text-ink-4">{d.hint}</span>}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
