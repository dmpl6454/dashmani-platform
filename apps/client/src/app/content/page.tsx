"use client";
import { useState } from "react";
import Link from "next/link";
import { useClientContent } from "@/lib/hooks/use-content";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Your Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-[#FFF3C4] text-[#1A1A1A]",
  PENDING_APPROVAL: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  SCHEDULED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  PUBLISHED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  FAILED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

const STATUS_FILTERS = ["", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "REJECTED"];

export default function ClientContentPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useClientContent({ status, search });
  const posts = (data as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1">
        <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">Content</h2>
        <p className="text-[#7A7A7A] mt-1">Review and approve your content</p>
      </div>

      <div className="crx-animate-slide crx-delay-2 flex gap-3 items-center flex-wrap">
        <div className="relative max-w-xs">
          <input placeholder="Search content..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full px-4 py-2.5 border border-[#E8E0D0] rounded-full text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] bg-white" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${
                status === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FEFCF7]"
              }`}
            >
              {s ? STATUS_LABELS[s] || s : "All"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
        </div>
      ) : posts.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] py-12 text-center text-[#7A7A7A]">
          No content found.
        </div>
      ) : (
        <div className="space-y-3">
          {posts.map((post: any, idx: number) => (
            <Link key={post.id} href={`/content/${post.id}`}>
              <div className={`crx-animate-slide crx-delay-${Math.min(idx + 3, 6)} bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all cursor-pointer p-5`}>
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3 flex-1">
                    <div className="h-10 w-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-sm font-medium" style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}>
                      {(post.title || "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-[#1A1A1A]">{post.title}</p>
                      <p className="text-sm text-[#7A7A7A] mt-0.5">{post.project?.name}</p>
                      {post.caption && (
                        <p className="text-sm text-[#7A7A7A] mt-1 line-clamp-2">{post.caption}</p>
                      )}
                      <div className="flex gap-3 mt-2 text-xs text-[#B0B0B0]">
                        {post.account && (
                          <span>{post.account.platform?.name}: {post.account.handle}</span>
                        )}
                        {post.scheduledAt && (
                          <span>Scheduled: {new Date(post.scheduledAt).toLocaleString()}</span>
                        )}
                        {post.mediaUrls?.length > 0 && (
                          <span>{post.mediaUrls.length} media file(s)</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLOR[post.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>
                    {STATUS_LABELS[post.status] || post.status}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
