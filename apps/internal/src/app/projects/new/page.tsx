"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { apiFetch } from "@/lib/api";

const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase min-w-0";
const FIELD =
  "h-[38px] w-full px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const BTN_GHOST = "h-9 px-3.5 rounded-[6px] border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text hover:border-ds-line4 disabled:opacity-50";
const REQ = <span className="text-ds-gold ml-[3px]">*</span>;

export default function NewProjectPage() {
  const router = useRouter();
  const [clients, setClients] = useState<any[]>([]);
  const [form, setForm] = useState({ name: "", description: "", clientId: "", startDate: "", endDate: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/clients?limit=100").then((res: any) => setClients(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.startDate && form.endDate && form.endDate < form.startDate) {
      setError("End date cannot be earlier than start date.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          description: form.description || undefined,
          clientId: form.clientId,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
        }),
      });
      router.push("/projects");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pb-8">
      <section className="pt-[26px]">
        <Link href="/projects" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Projects
        </Link>
      </section>
      <section className="pt-3.5 pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Create New Project</h1>
      </section>
      <form
        onSubmit={handleSubmit}
        className="relative max-w-[560px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card px-5 sm:px-[26px] py-6 shadow-[0_12px_32px_rgba(0,0,0,.35)] overflow-hidden"
      >
        <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-70 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
        <div className="flex flex-col gap-4">
          {error && (
            <div role="alert" className="px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">{error}</div>
          )}
          <label className={LABEL}>
            <span>Project Name{REQ}</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Description</span>
            <textarea className={`${FIELD} h-auto min-h-[84px] py-2.5 resize-y`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className={LABEL}>
            <span>Client{REQ}</span>
            <select className={`${FIELD} px-2.5 cursor-pointer`} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required>
              <option value="" className="bg-ds-card">Select a client</option>
              {clients.map((c: any) => <option key={c.id} value={c.id} className="bg-ds-card">{c.companyName}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className={LABEL}>
              <span>Start Date</span>
              <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate && form.endDate < e.target.value ? "" : form.endDate })} className={`${FIELD} px-2.5`} />
            </label>
            <label className={LABEL}>
              <span>End Date</span>
              <input type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={`${FIELD} px-2.5`} />
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={loading} className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-[color:var(--hx-060D14)] text-[12px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60">{loading ? "Creating..." : "Create Project"}</button>
            <button type="button" onClick={() => router.back()} className={BTN_GHOST}>Cancel</button>
          </div>
        </div>
      </form>
    </div>
  );
}
