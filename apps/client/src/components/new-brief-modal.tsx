"use client";
import { useEffect, useState } from "react";
import { mutate } from "swr";
import { Button, Modal } from "./portal-shared";
import { apiFetch } from "@/lib/api";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { Actions } from "@/lib/portal-store";

interface NewBriefModalProps {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
}

export function NewBriefModal({ open, onClose, defaultProjectId }: NewBriefModalProps) {
  const { data: projectsData } = useClientProjects();
  const projects = projectsData?.items ?? [];

  const [projectId, setProjectId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setProjectId(defaultProjectId ?? projects[0]?.id ?? "");
      setTitle("");
      setDescription("");
      setReferenceUrl("");
      setError(null);
    }
  }, [open, defaultProjectId, projects]);

  const canSubmit =
    !!projectId && title.trim().length >= 2 && description.trim().length >= 2 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/client/content/brief", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          title: title.trim(),
          description: description.trim(),
          ...(referenceUrl.trim() ? { referenceUrl: referenceUrl.trim() } : {}),
        }),
      });
      // Invalidate every content list query so the new draft surfaces.
      mutate(
        (key) => typeof key === "string" && key.startsWith("/client/content"),
        undefined,
        { revalidate: true }
      );
      Actions.toast({ kind: "success", text: "Brief submitted." });
      onClose();
    } catch (err: any) {
      setError(err?.message ?? "Could not submit brief.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New brief"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? "Submitting..." : "Submit brief"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Project">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full h-9 px-2.5 text-[13px] bg-bg/40 border border-border rounded-md outline-none focus:bg-surface focus:border-ink"
          >
            {projects.length === 0 && <option value="">No projects available</option>}
            {projects.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>

        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What is this brief about?"
            className="w-full h-9 px-2.5 text-[13px] bg-bg/40 border border-border rounded-md outline-none focus:bg-surface focus:border-ink"
            maxLength={200}
            autoFocus
          />
        </Field>

        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Describe what you'd like the agency to create. The more detail the better."
            className="w-full px-2.5 py-2 text-[13px] bg-bg/40 border border-border rounded-md outline-none focus:bg-surface focus:border-ink resize-none"
            maxLength={4000}
          />
        </Field>

        <Field label="Reference URL (optional)">
          <input
            value={referenceUrl}
            onChange={(e) => setReferenceUrl(e.target.value)}
            placeholder="https://..."
            className="w-full h-9 px-2.5 text-[13px] bg-bg/40 border border-border rounded-md outline-none focus:bg-surface focus:border-ink"
          />
        </Field>

        {error && <div className="text-[12px] text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-medium text-ink-3 mb-1.5">{label}</div>
      {children}
    </div>
  );
}
