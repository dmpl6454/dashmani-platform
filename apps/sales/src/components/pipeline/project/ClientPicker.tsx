"use client";
// The Pipeline project's client picker (New project sheet, client link panel). Its
// "+ Add new client" option opens the same dialog as the invoice editor: the client is created
// through POST /sales/clients and selected here, and whatever was typed in the sheet stays.
import { useId, useState } from "react";
import { UserPlus } from "lucide-react";
import { useClients } from "@/lib/hooks";
import { NewClientDialog } from "@/components/client-select";

const ADD_NEW = "__add_new__";

export function ClientPicker({
  value,
  onChange,
  currentName,
  label = "Client",
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  currentName?: string | null;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const { data, error, isLoading } = useClients();
  const [adding, setAdding] = useState(false);
  const clients = data ?? [];
  const missing = value && !clients.some((c) => c.id === value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <label htmlFor={id} className="block text-[12.5px] font-semibold text-ink-2">
          {label} <span className="text-ink-4 font-medium">(optional)</span>
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-ink-3 underline hover:text-ink disabled:opacity-50"
        >
          <UserPlus size={12} aria-hidden /> Add new client
        </button>
      </div>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === ADD_NEW) {
            setAdding(true);
            return;
          }
          onChange(e.target.value || null);
        }}
        className="w-full max-w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
      >
        <option value="">No client</option>
        <option value={ADD_NEW}>+ Add new client…</option>
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
      {adding && (
        <NewClientDialog
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setAdding(false);
            onChange(c.id);
          }}
        />
      )}
    </div>
  );
}
