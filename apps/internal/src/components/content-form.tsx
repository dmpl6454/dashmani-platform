"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

const LABEL = "text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const FIELD =
  "w-full h-[46px] px-4 rounded-[12px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const GHOST_BTN =
  "h-[42px] px-5 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold whitespace-nowrap hover:text-ds-text hover:border-[color:var(--hx-2A4658)] disabled:opacity-60";
const GOLD_BTN =
  "inline-flex items-center gap-2 h-[42px] px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";

interface ContentFormProps {
  content?: any;
}

export function ContentForm({ content }: ContentFormProps) {
  const router = useRouter();
  const isEdit = !!content;
  const [projects, setProjects] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({
    title: content?.title || "",
    caption: content?.caption || "",
    projectId: content?.project?.id || "",
    accountId: content?.account?.id || "",
    scheduledAt: content?.scheduledAt ? content.scheduledAt.slice(0, 16) : "",
    mediaUrls: content?.mediaUrls?.join("\n") || "",
  });
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [scheduledAtError, setScheduledAtError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/projects?limit=100").then((res: any) => setProjects(res.data || []));
    // limit=500: prod has ~452 accounts; the "Select account" dropdown must list them all (API caps at 50 otherwise, frontend default was 100).
    apiFetch("/accounts?limit=500").then((res: any) => setAccounts(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let hasError = false;
    if (!isEdit && !form.accountId) { setAccountError("Account is required"); hasError = true; } else { setAccountError(""); }
    if (!isEdit && !form.scheduledAt) { setScheduledAtError("Scheduled date/time is required"); hasError = true; } else { setScheduledAtError(""); }
    if (hasError) return;
    setLoading(true);
    try {
      const mediaUrls = form.mediaUrls
        .split("\n")
        .map((u: string) => u.trim())
        .filter((u: string) => u.length > 0);

      const payload: any = {
        title: form.title,
        caption: form.caption || undefined,
        projectId: form.projectId,
        accountId: form.accountId || undefined,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : undefined,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      };

      if (isEdit) {
        await apiFetch(`/content/${content.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/content", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/content");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="relative mt-[26px] rounded-[16px] border border-ds-line3 bg-ds-card shadow-[0_14px_36px_rgba(0,0,0,.32)] overflow-hidden">
      <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-60 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
      <div className="px-6 pt-[22px] pb-[18px] border-b border-ds-line">
        <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Content Studio</p>
        <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-.02em] text-ds-text">{isEdit ? "Edit Content Post" : "Create New Content Post"}</h1>
      </div>
      <form onSubmit={handleSubmit} className="px-6 py-[22px] flex flex-col gap-[18px] max-w-[560px]">
        {error && (
          <div role="alert" className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]">{error}</div>
        )}
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Title<span className="text-ds-gold ml-[3px]">*</span></span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Caption</span>
          <textarea
            className={`${FIELD} h-auto min-h-[100px] py-3.5 leading-[1.55] resize-y`}
            value={form.caption}
            onChange={(e) => setForm({ ...form, caption: e.target.value })}
            placeholder="Write the post caption/body..."
          />
        </label>
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Project<span className="text-ds-gold ml-[3px]">*</span></span>
          <select
            className={`${FIELD} cursor-pointer`}
            value={form.projectId}
            onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            required
          >
            <option value="" className="bg-ds-card">Select a project</option>
            {projects.map((p: any) => (
              <option key={p.id} value={p.id} className="bg-ds-card">
                {p.name} ({p.client?.companyName})
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-[7px]">
          <label htmlFor="content-account" className={LABEL}>Social Account{!isEdit && <span className="text-ds-gold ml-[3px]">*</span>}</label>
          <select
            id="content-account"
            className={`${FIELD} cursor-pointer ${accountError ? "!border-[rgba(251,113,133,.6)]" : ""}`}
            value={form.accountId}
            onChange={(e) => { setForm({ ...form, accountId: e.target.value }); if (accountError) setAccountError(""); }}
          >
            <option value="" className="bg-ds-card">Select account...</option>
            {accounts.map((acc: any) => (
              <option key={acc.id} value={acc.id} className="bg-ds-card">
                {acc.platform?.name}: {acc.handle}
              </option>
            ))}
          </select>
          {accountError && <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] font-semibold">{accountError}</p>}
        </div>
        <div className="flex flex-col gap-[7px]">
          <label htmlFor="content-scheduled" className={LABEL}>Scheduled Date/Time{!isEdit && <span className="text-ds-gold ml-[3px]">*</span>}</label>
          <input
            id="content-scheduled"
            type="datetime-local"
            value={form.scheduledAt}
            onChange={(e) => { setForm({ ...form, scheduledAt: e.target.value }); if (scheduledAtError) setScheduledAtError(""); }}
            className={`${FIELD} ${scheduledAtError ? "!border-[rgba(251,113,133,.6)]" : ""}`}
          />
          {scheduledAtError && <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] font-semibold">{scheduledAtError}</p>}
        </div>
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Media URLs (one per line)</span>
          <textarea
            className={`${FIELD} h-auto min-h-[80px] py-3.5 leading-[1.55] resize-y`}
            value={form.mediaUrls}
            onChange={(e) => setForm({ ...form, mediaUrls: e.target.value })}
            placeholder={"https://example.com/image1.jpg\nhttps://example.com/image2.jpg"}
          />
        </label>
        <div className="flex gap-2.5 flex-wrap pt-1">
          <button type="submit" disabled={loading} className={GOLD_BTN}>
            {loading ? "Saving..." : isEdit ? "Update Content" : "Create Content"}
          </button>
          <button type="button" onClick={() => router.back()} className={GHOST_BTN}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
