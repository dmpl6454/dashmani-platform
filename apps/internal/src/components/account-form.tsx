"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/api";

const inputCls = "w-full h-[38px] px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] tracking-normal normal-case font-normal placeholder:text-ds-t4 outline-none transition-colors focus:border-ds-gold [color-scheme:dark]";
const labelCls = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const ghostBtn = "h-9 px-3.5 rounded-[6px] border border-ds-line2 bg-transparent text-ds-t2 text-[12px] font-semibold transition-colors hover:border-ds-line4 hover:text-ds-text disabled:opacity-50";
const goldBtn = "h-9 px-[18px] rounded-[6px] bg-ds-gold text-ds-bg text-[12px] font-bold inline-flex items-center gap-1.5 transition-colors hover:bg-ds-gold2 disabled:opacity-50";

interface AccountFormProps {
  account?: any;
}

export function AccountForm({ account }: AccountFormProps) {
  const router = useRouter();
  const isEdit = !!account;
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [form, setForm] = useState({
    handle: account?.handle || "",
    displayName: account?.displayName || "",
    platformId: account?.platform?.id || "",
    clientName: account?.clientName || "",
    profileUrl: account?.profileUrl || "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/platforms").then((res: any) => setPlatforms(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload: any = { ...form };
      if (!payload.clientName) delete payload.clientName;
      if (!payload.profileUrl) delete payload.profileUrl;
      if (isEdit) {
        delete payload.platformId;
        await apiFetch(`/accounts/${account.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/accounts", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/accounts");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const fields = [
    { key: "handle", label: "Handle", placeholder: "@username", required: true },
    { key: "displayName", label: "Display Name", placeholder: "", required: true },
    { key: "clientName", label: "Client Name", placeholder: "Optional", required: false },
    { key: "profileUrl", label: "Profile URL", placeholder: "https://...", required: false },
  ] as const;

  return (
    <div className="rounded-[10px] border border-ds-line bg-ds-card overflow-hidden">
      <div className="px-[22px] py-4 border-b border-ds-line">
        <h2 className="text-[14px] font-semibold text-ds-text">{isEdit ? "Edit Account" : "Add Social Account"}</h2>
      </div>
      <div className="p-[22px]">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-lg">
          {error && <p role="alert" className="text-[12px] text-ds-redsoft">{error}</p>}
          {!isEdit && (
            <label className={labelCls}>
              Platform
              <span className="relative">
                <select
                  className={`${inputCls} appearance-none pr-8 cursor-pointer`}
                  value={form.platformId}
                  onChange={(e) => setForm({ ...form, platformId: e.target.value })}
                  required
                >
                  <option value="">Select platform</option>
                  {platforms.map((p: any) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
              </span>
            </label>
          )}
          {fields.map((f) => (
            <label key={f.key} className={labelCls}>
              {f.label}
              <input
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                placeholder={f.placeholder || undefined}
                required={f.required}
                className={inputCls}
              />
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={loading} className={goldBtn}>{loading ? "Saving..." : isEdit ? "Update" : "Add Account"}</button>
            <button type="button" onClick={() => router.back()} className={ghostBtn}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
