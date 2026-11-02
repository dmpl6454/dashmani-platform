"use client";
/**
 * Pick the client company a project is for (sales clients, `GET /sales/clients`). A plain
 * <select> — the client list is bounded (≤ 500) and already cached by the Clients page. The
 * current value stays selectable even if it is missing from the list (e.g. still loading).
 */
import { useId } from "react";
import { useClients } from "@/lib/hooks";

export function ClientPicker({
  value,
  onChange,
  currentName,
  label = "Client",
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** The current client's name, shown while the list loads. */
  currentName?: string | null;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const { data, error, isLoading } = useClients();
  const clients = data ?? [];
  const missing = value && !clients.some((c) => c.id === value);
  return (
    <div>
      <label htmlFor={id} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
        {label} <span className="text-ink-4 font-medium">(optional)</span>
      </label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full max-w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
      >
        <option value="">No client</option>
        {missing && <option value={value}>{currentName || "Current client"}</option>}
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.companyName}
          </option>
        ))}
      </select>
      {error ? (
        <p className="mt-1 text-[12px] text-danger">Couldn&apos;t load the client list — try again in a moment.</p>
      ) : isLoading && !data ? (
        <p className="mt-1 text-[12px] text-ink-4">Loading clients…</p>
      ) : null}
    </div>
  );
}
