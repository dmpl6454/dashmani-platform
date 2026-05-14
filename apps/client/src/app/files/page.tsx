"use client";
import { useEffect, useState } from "react";
import { Topstrip } from "@/components/portal-topstrip";
import { Empty, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientFiles } from "@/lib/hooks/use-files";
import { useClientProjects } from "@/lib/hooks/use-projects";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesPage() {
  const { data: projectsData } = useClientProjects();
  const projects = (projectsData as any)?.data ?? [];

  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [debouncedSearch, setDebouncedSearch] = useState<string | undefined>(undefined);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search || undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, error, isLoading } = useClientFiles(projectId, debouncedSearch);

  return (
    <>
      <Topstrip
        title="Files"
        sub={data ? `${data.length} files` : undefined}
      />

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-rule flex items-center gap-3">
        {/* Search input */}
        <div className="relative flex-1 max-w-xs">
          <Icon.Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 pr-3 w-full bg-surface border border-border rounded text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-border"
          />
        </div>

        <div className="flex-1" />

        {/* Project filter */}
        <div className="relative">
          <select
            value={projectId || ""}
            onChange={(e) => setProjectId(e.target.value || undefined)}
            className="h-8 pl-2 pr-7 bg-surface border border-border rounded text-[12px] text-ink appearance-none cursor-pointer focus:outline-none"
          >
            <option value="">All projects</option>
            {projects.map((p: { id: string; name: string }) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Icon.ChevDown
            size={12}
            className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-ink-3"
          />
        </div>
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        {error ? (
          <PageError message={error?.message} />
        ) : (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Table header */}
            <div className="grid grid-cols-[auto_1fr_160px_80px_120px_40px] items-center gap-3 px-4 h-10 border-b border-rule bg-muted/30 text-[11px] uppercase tracking-wider font-medium text-ink-3">
              <span className="w-7" />
              <span>Name</span>
              <span>Project</span>
              <span>Size</span>
              <span>Date</span>
              <span />
            </div>

            {/* Loading skeletons */}
            {isLoading && (
              <>
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[auto_1fr_160px_80px_120px_40px] items-center gap-3 px-4 h-[52px] border-b border-rule last:border-b-0"
                  >
                    <Skeleton className="w-7 h-7" />
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-6 w-6 rounded-md" />
                  </div>
                ))}
              </>
            )}

            {/* File rows */}
            {!isLoading && data && data.length > 0 &&
              data.map((file, i) => (
                <div
                  key={file.id}
                  className={`grid grid-cols-[auto_1fr_160px_80px_120px_40px] items-center gap-3 px-4 h-[52px] hover:bg-muted/40 transition-colors group ${i < data.length - 1 ? "border-b border-rule" : ""}`}
                >
                  {/* Icon */}
                  <div className="w-7 h-7 rounded bg-muted flex items-center justify-center text-ink-3 shrink-0">
                    <Icon.File size={15} sw={1.5} />
                  </div>

                  {/* Name */}
                  <span className="text-[13.5px] font-medium text-ink truncate" title={file.name}>
                    {file.name}
                  </span>

                  {/* Project */}
                  <span className="inline-flex items-center h-5 px-2 rounded bg-muted text-ink-3 text-[11px] font-medium truncate max-w-[160px]">
                    {file.project.name}
                  </span>

                  {/* Size */}
                  <span className="text-[12.5px] text-ink-2 tabular-nums">
                    {formatBytes(file.size)}
                  </span>

                  {/* Date */}
                  <span className="text-[12.5px] text-ink-2">
                    {new Date(file.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>

                  {/* Download */}
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                    onClick={(e) => e.stopPropagation()}
                    className="h-7 w-7 inline-flex items-center justify-center rounded text-ink-3 hover:bg-muted hover:text-ink transition-colors"
                    aria-label={`Download ${file.name}`}
                  >
                    <Icon.ArrowRight size={14} />
                  </a>
                </div>
              ))
            }

            {/* Empty state */}
            {!isLoading && !error && data && data.length === 0 && (
              <Empty
                icon={<Icon.File size={22} />}
                title="No files yet"
                hint="Files uploaded to your projects appear here."
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}
