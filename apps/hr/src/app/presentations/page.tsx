"use client";
import { useState, useEffect, useRef } from "react";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import {
  ArrowLeft, Plus, FileText, Trash2,
  Download, Eye, Edit2, Save, X, ChevronRight, Sparkles, BarChart3, Loader2,
} from "lucide-react";

import { apiFetch } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

async function apiFetchRaw(path: string): Promise<string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error("Export failed");
  return res.text();
}

const DEFAULT_MARKDOWN = `---
marp: true
theme: default
paginate: true
---

# My Presentation

Your Name — ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}

---

## Slide 2

- Point one
- Point two
- Point three

---

## Slide 3

### Add your content here

You can use **bold**, *italic*, and \`code\` formatting.

> Add quotes for emphasis

---

## Links & Media

Share links to your work:

- [Link title](https://example.com)
- Add images: \`![alt](url)\`

---

## Thank You!

Questions?
`;

const TEMPLATES = [
  {
    name: "Report",
    markdown: `---
marp: true
theme: default
paginate: true
---

# Weekly Report

**Submitted by:** Your Name
**Date:** ${new Date().toLocaleDateString("en-IN")}

---

## Work Completed

- Task 1: Description
- Task 2: Description
- Task 3: Description

---

## Links Submitted

| Platform | Account | Link |
|----------|---------|------|
| Instagram | @handle | [Post](https://instagram.com) |
| Facebook | Page Name | [Post](https://facebook.com) |

---

## Metrics

- Total posts: **X**
- Engagement rate: **X%**
- Follower growth: **+X**

---

## Next Week Plan

1. Priority task 1
2. Priority task 2
3. Priority task 3
`,
  },
  {
    name: "Client Pitch",
    markdown: `---
marp: true
theme: default
paginate: true
backgroundColor: #1a1a1a
color: #ffffff
---

# Client Proposal

**Digital Sukoon**

---

## About Us

We are a full-service marketing agency specializing in:

- Social Media Management
- Content Creation
- Brand Strategy
- Influencer Marketing

---

## Our Reach

- **100M+** Total followers across platforms
- **400+** Social media accounts managed
- **50+** Brands served

---

## Services

### Social Media Management
- Daily content posting
- Community engagement
- Analytics & reporting

### Content Production
- Reels & short videos
- Graphics & carousels
- Blog & copywriting

---

## Pricing

| Plan | Monthly |
|------|---------|
| Starter | ₹15,000 |
| Growth | ₹35,000 |
| Premium | ₹75,000 |

---

## Let's Connect!

📧 hello@digitalsukoon.com
🌐 digitalsukoon.com
`,
  },
  {
    name: "Blank",
    markdown: DEFAULT_MARKDOWN,
  },
];

export default function PresentationsPage() {
  const { data, mutate } = useSWR("/hr/presentations", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  const presentations = (data as any)?.data ?? [];

  const [mode, setMode] = useState<"list" | "edit" | "preview">("list");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [liveHtml, setLiveHtml] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AI Generation state
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiType, setAiType] = useState<"presentation" | "report">("presentation");
  const [aiTopic, setAiTopic] = useState("");
  const [aiSlideCount, setAiSlideCount] = useState(10);
  const [aiStyle, setAiStyle] = useState("");
  const [aiAudience, setAiAudience] = useState("");
  const [aiNotes, setAiNotes] = useState("");
  const [aiGenerating, setAiGenerating] = useState(false);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { Marp } = await import("@marp-team/marp-core");
        const marp = new Marp({ html: false });
        const { html, css } = marp.render(markdown);
        setLiveHtml(`<!DOCTYPE html><html><head><style>${css}</style></head><body>${html}</body></html>`);
      } catch {
        setLiveHtml("");
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [markdown]);

  function newPresentation(template?: string) {
    setCurrentId(null);
    setTitle("");
    setMarkdown(template || DEFAULT_MARKDOWN);
    setMode("edit");
  }

  async function loadPresentation(id: string) {
    setLoading(true);
    try {
      const res: any = await apiFetch(`/hr/presentations/${id}`);
      setCurrentId(res.data.id);
      setTitle(res.data.title);
      setMarkdown(res.data.markdown);
      setMode("edit");
    } catch (e: any) { alert(e.message); }
    finally { setLoading(false); }
  }

  async function handleSave() {
    if (!title.trim()) { alert("Please enter a title"); return; }
    setSaving(true);
    try {
      if (currentId) {
        await apiFetch(`/hr/presentations/${currentId}`, {
          method: "PUT",
          body: JSON.stringify({ title, markdown }),
        });
      } else {
        const res: any = await apiFetch("/hr/presentations", {
          method: "POST",
          body: JSON.stringify({ title, markdown }),
        });
        setCurrentId(res.data.id);
      }
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  }

  async function handleExport() {
    if (!currentId) {
      await handleSave();
    }
    const id = currentId;
    if (!id) return;
    try {
      const html = await apiFetchRaw(`/hr/presentations/${id}/export`);
      setPreviewHtml(html);
      setMode("preview");
    } catch (e: any) { alert(e.message); }
  }

  async function handleDownload() {
    if (!currentId) return;
    try {
      const html = await apiFetchRaw(`/hr/presentations/${currentId}/export`);
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title || "presentation"}.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { alert(e.message); }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this presentation?")) return;
    try {
      await apiFetch(`/hr/presentations/${id}`, { method: "DELETE" });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleAiGenerate() {
    if (!aiTopic.trim()) { alert("Please enter a topic"); return; }
    setAiGenerating(true);
    try {
      const res: any = await apiFetch("/hr/presentations/ai/generate", {
        method: "POST",
        body: JSON.stringify({
          topic: aiTopic,
          type: aiType,
          slideCount: aiSlideCount,
          style: aiStyle || undefined,
          audience: aiAudience || undefined,
          additionalNotes: aiNotes || undefined,
        }),
      });
      setCurrentId(null);
      setTitle(res.data.title);
      setMarkdown(res.data.markdown);
      setShowAiModal(false);
      setAiTopic("");
      setAiStyle("");
      setAiAudience("");
      setAiNotes("");
      setMode("edit");
    } catch (e: any) { alert(e.message); }
    finally { setAiGenerating(false); }
  }

  const slideCount = markdown.split(/\n---\n/).length;

  if (mode === "preview") {
    return (
      <div className="min-h-screen bg-ink">
        <div className="flex items-center justify-between px-4 py-3 bg-ink/90 border-b border-white/10">
          <button
            onClick={() => setMode("edit")}
            className="flex items-center gap-2 text-white/60 hover:text-white text-[13px] font-medium transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Editor
          </button>
          <h2 className="text-white text-[13px] font-semibold">{title}</h2>
          <button
            onClick={handleDownload}
            className="btn-3d inline-flex items-center gap-2 px-4 h-9 rounded-xl bg-indigo-soft text-indigo text-[12px] font-semibold border-2 border-indigo/20"
          >
            <Download className="h-3.5 w-3.5" /> Download HTML
          </button>
        </div>
        <iframe srcDoc={previewHtml} className="w-full" style={{ height: "calc(100vh - 52px)", border: "none" }} />
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <div className="min-h-screen bg-bg">
        {/* Editor Header */}
        <div className="sticky top-0 z-10 bg-surface border-b-2 border-ink/7 px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMode("list")}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            >
              <ArrowLeft className="h-5 w-5 text-ink" />
            </button>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Presentation title..."
              className="text-[18px] font-display font-light text-ink bg-transparent border-none outline-none placeholder:text-ink-4 w-72"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-ink-4 font-medium mr-1">{slideCount} slides</span>
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-3d inline-flex items-center gap-2 px-4 h-9 rounded-xl bg-ink text-white text-[12px] font-semibold border-2 border-ink disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={handleExport}
              className="btn-3d inline-flex items-center gap-2 px-4 h-9 rounded-xl bg-indigo-soft text-indigo text-[12px] font-semibold border-2 border-indigo/20"
            >
              <Eye className="h-3.5 w-3.5" /> Preview & Export
            </button>
          </div>
        </div>

        {/* Editor Body */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-6" style={{ height: "calc(100vh - 56px)" }}>
          {/* Markdown Editor */}
          <div className="v3-card overflow-hidden flex flex-col">
            <div className="px-5 h-11 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Marp Markdown</span>
              <span className="text-[11px] text-ink-4 font-medium">Use --- to separate slides</span>
            </div>
            <textarea
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
              className="flex-1 p-4 font-mono text-[12px] text-ink bg-bg resize-none focus:outline-none"
              spellCheck={false}
            />
          </div>

          {/* Live Preview Panel */}
          <div className="v3-card overflow-hidden flex flex-col">
            <div className="px-5 h-11 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Live Preview</span>
              <span className="text-[11px] text-ink-4 font-medium">{slideCount} slides</span>
            </div>
            {liveHtml ? (
              <iframe
                srcDoc={liveHtml}
                sandbox="allow-same-origin"
                className="flex-1 w-full border-none bg-white"
                title="Marp live preview"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-[12px] text-ink-4 font-medium">Start typing to see a live preview</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // List mode
  return (
    <>
      <Topstrip title="Presentations" sub="Create slide decks with Marp markdown" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-5">

        {/* AI Create */}
        <div>
          <p className="text-[11.5px] font-bold text-ink-3 mb-3 uppercase tracking-wider">Create with AI</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              onClick={() => { setAiType("presentation"); setAiSlideCount(10); setShowAiModal(true); }}
              className="v3-card-lift v3-card p-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-xl bg-indigo-soft flex items-center justify-center shrink-0">
                  <Sparkles className="h-5 w-5 text-indigo" />
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-ink">Create Presentation</p>
                  <p className="text-[11px] text-ink-4 font-medium mt-0.5">AI generates slides from your topic</p>
                </div>
                <ChevronRight className="h-4 w-4 text-ink-4 group-hover:text-indigo transition-colors" />
              </div>
            </button>
            <button
              onClick={() => { setAiType("report"); setAiSlideCount(8); setShowAiModal(true); }}
              className="v3-card-lift v3-card p-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-xl bg-muted flex items-center justify-center shrink-0">
                  <BarChart3 className="h-5 w-5 text-ink-3" />
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-semibold text-ink">Create Report</p>
                  <p className="text-[11px] text-ink-4 font-medium mt-0.5">AI generates a structured report deck</p>
                </div>
                <ChevronRight className="h-4 w-4 text-ink-4 group-hover:text-ink transition-colors" />
              </div>
            </button>
          </div>
        </div>

        {/* Templates */}
        <div>
          <p className="text-[11.5px] font-bold text-ink-3 mb-3 uppercase tracking-wider">Start from a template</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.name}
                onClick={() => newPresentation(tpl.markdown)}
                className="v3-card-lift v3-card p-4 text-left group"
              >
                <div className="flex items-center gap-3 mb-1">
                  <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center">
                    <Plus className="h-4 w-4 text-ink-3" />
                  </div>
                  <div>
                    <p className="text-[13px] font-semibold text-ink">{tpl.name}</p>
                    <p className="text-[11px] text-ink-4 font-medium">{tpl.markdown.split(/\n---\n/).length} slides</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Saved Presentations */}
        <div>
          <p className="text-[11.5px] font-bold text-ink-3 mb-3 uppercase tracking-wider">Your presentations</p>
          {presentations.length === 0 ? (
            <div className="v3-card p-10 text-center">
              <FileText className="h-9 w-9 mx-auto mb-3 text-ink-4" />
              <p className="text-[13px] text-ink-3 font-medium">No presentations yet. Pick a template above to get started.</p>
            </div>
          ) : (
            <div className="v3-card">
              <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <span className="text-[13px] font-semibold text-ink">Saved</span>
                <span className="ml-2 h-5 w-5 rounded-full bg-muted text-ink-3 text-[11px] font-bold flex items-center justify-center">{presentations.length}</span>
              </div>
              <div className="px-5 py-3 space-y-1">
                {presentations.map((p: any) => (
                  <div key={p.id} className="v3-row flex items-center gap-4 px-4 py-3 rounded-xl">
                    <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-ink-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-ink truncate">{p.title || "Untitled"}</p>
                      <p className="text-[11px] text-ink-4 font-medium">
                        Updated {new Date(p.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => loadPresentation(p.id)}
                        className="p-2 rounded-lg hover:bg-muted text-ink-4 hover:text-ink transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="p-2 rounded-lg hover:bg-danger-bg text-ink-4 hover:text-danger transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* AI Generation Modal */}
      {showAiModal && (
        <div
          className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => !aiGenerating && setShowAiModal(false)}
        >
          <div
            className="bg-surface rounded-2xl border border-ink/10 shadow-[0_16px_48px_rgba(0,0,0,0.16)] w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 h-14 border-b-2 border-ink/7">
              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${aiType === "presentation" ? "bg-indigo-soft" : "bg-muted"}`}>
                  {aiType === "presentation"
                    ? <Sparkles className="h-4 w-4 text-indigo" />
                    : <BarChart3 className="h-4 w-4 text-ink-3" />
                  }
                </div>
                <div>
                  <p className="text-[13px] font-semibold text-ink">
                    Create {aiType === "presentation" ? "Presentation" : "Report"} with AI
                  </p>
                  <p className="text-[11px] text-ink-4 font-medium">Powered by Claude</p>
                </div>
              </div>
              <button
                onClick={() => !aiGenerating && setShowAiModal(false)}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors"
              >
                <X className="h-4 w-4 text-ink-3" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="px-5 py-4 space-y-4">
              {/* Type Toggle */}
              <div className="flex gap-1.5 p-1 bg-muted rounded-xl">
                <button
                  onClick={() => { setAiType("presentation"); setAiSlideCount(10); }}
                  className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-semibold transition-all ${aiType === "presentation" ? "bg-surface text-indigo shadow-sm" : "text-ink-3 hover:text-ink"}`}
                >
                  Presentation
                </button>
                <button
                  onClick={() => { setAiType("report"); setAiSlideCount(8); }}
                  className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-semibold transition-all ${aiType === "report" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
                >
                  Report
                </button>
              </div>

              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Topic *</p>
                <input
                  value={aiTopic}
                  onChange={(e) => setAiTopic(e.target.value)}
                  placeholder={aiType === "presentation" ? "e.g., Q1 Marketing Strategy for Brand X" : "e.g., Monthly Social Media Performance Report"}
                  className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors"
                  disabled={aiGenerating}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Slides</p>
                  <select
                    value={aiSlideCount}
                    onChange={(e) => setAiSlideCount(Number(e.target.value))}
                    className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors"
                    disabled={aiGenerating}
                  >
                    {[5, 8, 10, 12, 15, 20].map((n) => (
                      <option key={n} value={n}>{n} slides</option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Audience</p>
                  <input
                    value={aiAudience}
                    onChange={(e) => setAiAudience(e.target.value)}
                    placeholder="e.g., Client, Team"
                    className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors"
                    disabled={aiGenerating}
                  />
                </div>
              </div>

              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Style / Tone</p>
                <input
                  value={aiStyle}
                  onChange={(e) => setAiStyle(e.target.value)}
                  placeholder="e.g., Professional, Casual, Data-heavy"
                  className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors"
                  disabled={aiGenerating}
                />
              </div>

              <div>
                <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Additional Notes</p>
                <textarea
                  value={aiNotes}
                  onChange={(e) => setAiNotes(e.target.value)}
                  placeholder="Any specific points, data, or structure you want included..."
                  rows={3}
                  className="w-full px-3 py-2.5 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors resize-none"
                  disabled={aiGenerating}
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-4 border-t-2 border-ink/7 flex items-center justify-between">
              <p className="text-[11px] text-ink-4 font-medium">You can edit the generated content after</p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAiModal(false)}
                  disabled={aiGenerating}
                  className="px-4 h-9 rounded-xl text-[12px] font-medium text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAiGenerate}
                  disabled={aiGenerating || !aiTopic.trim()}
                  className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[12px] font-semibold border-2 border-ink disabled:opacity-50"
                >
                  {aiGenerating ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating...</>
                  ) : (
                    <><Sparkles className="h-3.5 w-3.5" /> Generate</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
