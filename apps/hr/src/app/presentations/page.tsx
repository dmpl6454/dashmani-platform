"use client";
import { useState, useCallback } from "react";
import useSWR from "swr";
import Link from "next/link";
import {
  ArrowLeft, Plus, Presentation as PresentationIcon, FileText, Trash2,
  Download, Eye, Edit2, Save, X, ChevronRight,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || "Request failed");
  return json;
}

async function apiFetchRaw(path: string): Promise<string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
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

  // Simple slide count from markdown
  const slideCount = markdown.split(/\n---\n/).length;

  if (mode === "preview") {
    return (
      <div className="min-h-screen bg-[#1A1A1A]">
        <div className="flex items-center justify-between px-4 py-3 bg-[#2B2B2B]">
          <button onClick={() => setMode("edit")} className="flex items-center gap-2 text-white/70 hover:text-white text-sm">
            <ArrowLeft className="h-4 w-4" /> Back to Editor
          </button>
          <h2 className="text-white text-sm font-medium">{title}</h2>
          <button onClick={handleDownload} className="flex items-center gap-2 bg-[#F5D547] text-[#1A1A1A] px-4 py-1.5 rounded-full text-sm font-medium hover:bg-[#e6c63e] transition-colors">
            <Download className="h-4 w-4" /> Download HTML
          </button>
        </div>
        <iframe srcDoc={previewHtml} className="w-full" style={{ height: "calc(100vh - 52px)", border: "none" }} />
      </div>
    );
  }

  if (mode === "edit") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#FDF6E3] via-[#F7ECD5] to-[#EFE2C4]">
        <div className="max-w-7xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <button onClick={() => setMode("list")} className="p-2 rounded-lg hover:bg-white/60 transition-colors">
                <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
              </button>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Presentation title..."
                className="text-2xl font-serif font-light text-[#1A1A1A] bg-transparent border-none outline-none placeholder:text-[#B0B0B0] w-96"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#7A7A7A] mr-2">{slideCount} slides</span>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-[#1A1A1A] text-white px-4 py-2 rounded-full text-sm font-medium hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
                <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
              </button>
              <button onClick={handleExport} className="flex items-center gap-2 bg-[#F5D547] text-[#1A1A1A] px-4 py-2 rounded-full text-sm font-medium shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] transition-all">
                <Eye className="h-4 w-4" /> Preview & Export
              </button>
            </div>
          </div>

          {/* Editor */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Markdown Editor */}
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#F0EAD8] flex items-center justify-between">
                <h3 className="text-sm font-medium text-[#1A1A1A]">Marp Markdown</h3>
                <span className="text-xs text-[#7A7A7A]">Use --- to separate slides</span>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                className="w-full h-[calc(100vh-200px)] p-4 font-mono text-sm text-[#1A1A1A] bg-white resize-none focus:outline-none"
                spellCheck={false}
              />
            </div>

            {/* Help Panel */}
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#F0EAD8]">
                <h3 className="text-sm font-medium text-[#1A1A1A]">Marp Cheatsheet</h3>
              </div>
              <div className="p-4 space-y-4 text-sm text-[#7A7A7A] overflow-y-auto" style={{ maxHeight: "calc(100vh - 200px)" }}>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Slide Separator</h4>
                  <code className="bg-[#FFF3C4] px-2 py-0.5 rounded text-xs">---</code>
                  <p className="mt-1">Use three dashes on a new line to create a new slide</p>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Front Matter</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs overflow-x-auto">{`---
marp: true
theme: default
paginate: true
backgroundColor: #fff
color: #333
---`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Headings</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`# Title (large)
## Subtitle
### Section`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Lists</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`- Bullet point
1. Numbered item
  - Nested item`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Tables</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`| Header | Header |
|--------|--------|
| Cell   | Cell   |`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Images</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`![bg](url)        # background
![bg left](url)   # split left
![w:300](url)     # sized image`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Styling</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`**bold** *italic* \`code\`
> blockquote
~~strikethrough~~`}</pre>
                </div>
                <div>
                  <h4 className="font-medium text-[#1A1A1A] mb-1">Per-slide Directives</h4>
                  <pre className="bg-[#FEFCF7] border border-[#E8E0D0] rounded-lg p-3 text-xs">{`<!-- _backgroundColor: black -->
<!-- _color: white -->
<!-- _class: lead -->`}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // List mode
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#FDF6E3] via-[#F7ECD5] to-[#EFE2C4]">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="p-2 rounded-lg hover:bg-white/60 transition-colors">
              <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
            </Link>
            <div>
              <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Presentations</h1>
              <p className="text-sm text-[#7A7A7A]">Create slide decks with Marp markdown</p>
            </div>
          </div>
        </div>

        {/* Templates */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-[#7A7A7A] mb-3">Start from a template</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.name}
                onClick={() => newPresentation(tpl.markdown)}
                className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-left hover:border-[#F5D547] hover:shadow-[0_4px_16px_rgba(245,213,71,0.2)] transition-all group"
              >
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                    <Plus className="h-5 w-5 text-[#1A1A1A]" />
                  </div>
                  <div>
                    <p className="font-medium text-[#1A1A1A]">{tpl.name}</p>
                    <p className="text-xs text-[#7A7A7A]">{tpl.markdown.split(/\n---\n/).length} slides</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-[#B0B0B0] group-hover:text-[#F5D547] transition-colors ml-auto" />
              </button>
            ))}
          </div>
        </div>

        {/* Saved Presentations */}
        <div>
          <h3 className="text-sm font-medium text-[#7A7A7A] mb-3">Your presentations</h3>
          {presentations.length === 0 ? (
            <div className="bg-white rounded-xl border border-[#E8E0D0] p-10 text-center text-[#7A7A7A]">
              <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>No presentations yet. Pick a template above to get started.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {presentations.map((p: any) => (
                <div key={p.id} className="bg-white rounded-xl border border-[#E8E0D0] p-4 flex items-center gap-4 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition-all">
                  <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center shrink-0">
                    <FileText className="h-5 w-5 text-[#1A1A1A]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[#1A1A1A] truncate">{p.title || "Untitled"}</p>
                    <p className="text-xs text-[#7A7A7A]">
                      Updated {new Date(p.updatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => loadPresentation(p.id)} className="p-2 rounded-lg hover:bg-[#FFF8E1] text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors" title="Edit">
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(p.id)} className="p-2 rounded-lg hover:bg-red-50 text-[#7A7A7A] hover:text-red-600 transition-colors" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
