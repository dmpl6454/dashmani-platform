"use client";
import { useEffect, useRef, useState } from "react";
import { Topstrip } from "@/components/portal-topstrip";
import { IconButton, Empty, PageError, Skeleton, Button, SegTabs } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientFiles } from "@/lib/hooks/use-files";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { uploadFile } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileType(name: string): string {
  const ext = name.split(".").pop()?.toUpperCase() ?? "FILE";
  if (["JPG","JPEG","PNG","GIF","WEBP","SVG"].includes(ext)) return "IMG";
  if (["ZIP","RAR","TAR","GZ"].includes(ext)) return "ZIP";
  if (ext === "PDF") return "PDF";
  if (["DOC","DOCX"].includes(ext)) return "DOC";
  if (["XLS","XLSX"].includes(ext)) return "XLS";
  return ext.slice(0, 4);
}

const TYPE_COLORS: Record<string, string> = {
  PDF: "bg-terra-soft text-terra border-terra/20",
  ZIP: "bg-indigo-soft text-indigo border-indigo/20",
  IMG: "bg-sage-soft text-sage border-sage/20",
  DOC: "bg-action-soft text-ink-2 border-action/20",
  XLS: "bg-success-bg text-success border-success/20",
};

export default function FilesPage() {
  const { data: projectsData } = useClientProjects();
  const projects: any[] = projectsData?.items ?? [];

  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState<string | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [dragOver, setDragOver] = useState(false);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadProjectId, setUploadProjectId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search || undefined), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: files, error, isLoading, mutate } = useClientFiles(projectId, debouncedSearch);
  const fileList: any[] = files ?? [];

  const folders = [
    { id: undefined, label: "All files", count: fileList.length },
    ...projects.map((p) => ({
      id: p.id,
      label: p.name,
      count: fileList.filter((f) => (f.project?.id ?? f.project) === p.id).length,
    })),
  ];

  const displayed = projectId
    ? fileList.filter((f) => (f.project?.id ?? f.project) === projectId)
    : fileList;

  const totalMB = displayed.reduce((s, f) => s + (f.size || 0), 0) / (1024 * 1024);

  // Derive the project to upload to: use the sidebar filter if set, otherwise the picker
  const effectiveUploadProjectId = projectId ?? uploadProjectId;

  async function handleUpload(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (!effectiveUploadProjectId) {
      setUploadError("Select a project folder before uploading.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    let failed = 0;
    for (const file of Array.from(fileList)) {
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("projectId", effectiveUploadProjectId);
        await uploadFile("/client/files", fd);
      } catch (e: any) {
        failed++;
        setUploadError(e.message || "Upload failed");
      }
    }
    setUploading(false);
    if (failed === 0) setUploadError(null);
    mutate(); // refresh file list
  }

  async function handleDelete(fileId: string) {
    if (!confirm("Delete this file? This cannot be undone.")) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("clientAccessToken") : null;
      const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
      const res = await fetch(`${API_URL}/client/files/${fileId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Delete failed");
      mutate();
    } catch (e: any) {
      alert(e.message || "Could not delete file.");
    }
  }

  return (
    <>
      <Topstrip
        title="Files"
        sub={`${fileList.length} files across all projects`}
        right={
          <div className="flex items-center gap-2">
            <SegTabs
              value={viewMode}
              onChange={setViewMode}
              options={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]}
            />
          </div>
        }
      />

      <div className="files-layout">
        {/* ── Folder sidebar ── */}
        <div className="files-sidebar py-4 px-2">
          <div className="files-folders-label px-2 mb-2">
            <span className="text-[10px] uppercase tracking-widest font-bold text-ink-3">Folders</span>
          </div>
          <nav className="space-y-0.5">
            {folders.map((f, i) => (
              <button
                key={f.id ?? "all"}
                onClick={() => setProjectId(f.id)}
                className={`fade-up d${Math.min(i + 1, 8)} w-full flex items-center justify-between px-3 h-10 rounded-xl text-[13px] font-semibold transition-all
                  ${projectId === f.id ? "nav-active" : "text-ink-3 hover:bg-muted/80 hover:text-ink"}`}
              >
                <span className="truncate">{f.label}</span>
                <span className={`text-[10.5px] tabular-nums font-bold ${projectId === f.id ? "text-indigo/60" : "text-ink-4"}`}>
                  {f.count}
                </span>
              </button>
            ))}
          </nav>

          {/* Storage indicator */}
          <div className="files-storage mt-auto px-3 py-4">
            <div className="v3-card-sm p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider font-bold text-ink-3">Storage</div>
              <div className="h-2 bg-muted rounded-full overflow-hidden" style={{ border: "1px solid rgba(26,26,26,0.1)" }}>
                <div className="h-full bg-indigo rounded-full" style={{ width: "34%" }} />
              </div>
              <div className="text-[11.5px] font-semibold text-ink-2">
                {totalMB.toFixed(0)} MB <span className="text-ink-4 font-medium">used</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Main area ── */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 min-w-0">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleUpload(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            className={`mb-2 border-2 border-dashed rounded-2xl p-4 flex items-center justify-center gap-3 transition-all cursor-pointer
              ${dragOver ? "bg-indigo-soft border-indigo" : uploading ? "bg-muted/40 border-ink/20" : "border-ink/15 hover:border-ink/30 hover:bg-muted/30"}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleUpload(e.target.files)}
            />
            {uploading ? (
              <span className="text-[13px] font-semibold text-ink-3 animate-pulse">Uploading…</span>
            ) : (
              <>
                <Icon.Plus size={16} sw={2} className={dragOver ? "text-indigo" : "text-ink-3"} />
                <span className={`text-[13px] font-semibold ${dragOver ? "text-indigo" : "text-ink-3"}`}>
                  Drop files here or click to upload
                </span>
              </>
            )}
          </div>

          {/* Project picker — only shown when "All files" is active (no folder selected) */}
          {!projectId && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-[12px] text-ink-3 font-medium shrink-0">Upload to:</span>
              <select
                value={uploadProjectId}
                onChange={(e) => setUploadProjectId(e.target.value)}
                className="h-8 sm:h-9 px-2 sm:px-2.5 bg-surface rounded-lg sm:rounded-xl text-[12px] sm:text-[12.5px] text-ink outline-none font-medium"
                style={{ border: "2px solid rgba(26,26,26,0.15)" }}
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {uploadError && (
            <p className="mb-3 text-[12.5px] text-terra font-semibold">{uploadError}</p>
          )}

          {/* Summary + search */}
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mb-4">
            <span className="text-[13px] font-bold text-ink">{displayed.length} file{displayed.length !== 1 ? "s" : ""}</span>
            {totalMB > 0 && <span className="text-[12px] text-ink-3 font-medium">· {totalMB.toFixed(0)} MB total</span>}
            <div className="flex-1" />
            {/* Search */}
            <div className="relative">
              <Icon.Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search files…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 sm:h-9 pl-8 pr-3 bg-surface rounded-lg sm:rounded-xl text-[12px] sm:text-[12.5px] text-ink placeholder:text-ink-4 outline-none font-medium"
                style={{ border: "2px solid rgba(26,26,26,0.15)" }}
              />
            </div>
          </div>

          {error && <PageError message="Could not load files. Please refresh." />}

          {!error && viewMode === "list" ? (
            <div className="v3-card overflow-x-auto fade-up d2">
              <div
                className="tbl-head row-files px-5 h-11 bg-muted/40 text-[11px] uppercase tracking-wider font-bold text-ink-3 items-center"
                style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
              >
                <span></span><span>Name</span><span>Type</span><span className="text-right">Size</span><span>Uploaded</span><span></span>
              </div>

              {isLoading && [...Array(4)].map((_, i) => (
                <div key={i} className="row-files px-5 items-center h-row" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                  <Skeleton className="h-7 w-7" />
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-5 w-12" />
                  <Skeleton className="h-3 w-12 ml-auto" />
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-6 ml-auto" />
                </div>
              ))}

              {!isLoading && displayed.length === 0 && (
                <Empty icon={<Icon.File size={20} />} title="No files yet" hint="Drop files above to upload to a project." />
              )}

              {!isLoading && displayed.map((file, i) => {
                const type = fileType(file.name);
                return (
                  <div
                    key={file.id}
                    className="row-files px-5 items-center h-row v3-row cursor-pointer group fade-up"
                    style={{
                      animationDelay: `${(i + 3) * 0.05}s`,
                      ...(i < displayed.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}),
                    }}
                  >
                    <div className="h-7 w-7 rounded-lg bg-muted flex items-center justify-center text-ink-3" style={{ border: "1.5px solid rgba(26,26,26,0.1)" }}>
                      <Icon.File size={14} sw={1.5} />
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13.5px] font-semibold text-ink truncate">{file.name}</span>
                    </div>
                    <div>
                      <span className={`text-[10.5px] font-bold px-2 h-5 inline-flex items-center rounded-full border ${TYPE_COLORS[type] ?? "bg-muted text-ink-3 border-ink/10"}`}>
                        {type}
                      </span>
                    </div>
                    <span className="text-right text-[12.5px] text-ink-2 font-semibold tabular-nums">{formatBytes(file.size ?? 0)}</span>
                    <span className="text-[12px] text-ink-3 font-medium">
                      {new Date(file.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" })}
                    </span>
                    <div className="hover-reveal flex items-center justify-end gap-1">
                      <a href={file.url} target="_blank" rel="noopener noreferrer" download onClick={(e) => e.stopPropagation()}>
                        <IconButton size="sm" variant="ghost" icon={<Icon.ChevDown size={14} />} label="Download" />
                      </a>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(file.id); }}
                        className="h-7 w-7 flex items-center justify-center rounded-lg text-ink-4 hover:text-terra hover:bg-terra-soft transition-all"
                        aria-label="Delete file"
                      >
                        <Icon.X size={13} sw={2} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !error ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 fade-up d2">
              {isLoading && [...Array(8)].map((_, i) => (
                <Skeleton key={i} className="h-36 v3-card" />
              ))}
              {!isLoading && displayed.length === 0 && (
                <div className="col-span-full">
                  <Empty icon={<Icon.File size={20} />} title="No files yet" hint="Drop files above to upload to a project." />
                </div>
              )}
              {!isLoading && displayed.map((file, i) => {
                const type = fileType(file.name);
                return (
                  <div
                    key={file.id}
                    className="v3-card v3-card-lift p-4 cursor-pointer relative group"
                    style={{ animationDelay: `${i * 0.04}s` }}
                  >
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block"
                    >
                      <div className="h-9 w-9 rounded-xl bg-muted flex items-center justify-center text-ink-3 mb-3" style={{ border: "1.5px solid rgba(26,26,26,0.1)" }}>
                        <Icon.File size={16} sw={1.5} />
                      </div>
                      <div className="text-[13px] font-bold text-ink leading-tight line-clamp-2 mb-2">{file.name}</div>
                      <div className="flex items-center justify-between mt-auto">
                        <span className={`text-[10px] font-bold px-2 h-5 inline-flex items-center rounded-full border ${TYPE_COLORS[type] ?? "bg-muted text-ink-3 border-ink/10"}`}>
                          {type}
                        </span>
                        <span className="text-[11.5px] text-ink-3 font-semibold tabular-nums">{formatBytes(file.size ?? 0)}</span>
                      </div>
                    </a>
                    <button
                      onClick={() => handleDelete(file.id)}
                      className="absolute top-2 right-2 h-6 w-6 flex items-center justify-center rounded-lg text-ink-4 hover:text-terra hover:bg-terra-soft transition-all hover-reveal"
                      aria-label="Delete file"
                    >
                      <Icon.X size={12} sw={2} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
