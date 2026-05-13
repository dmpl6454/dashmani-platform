"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Search, MapPin, Briefcase, Clock, GraduationCap, ChevronRight, IndianRupee, Sparkles, ArrowRight, Building2, Users, Send } from "lucide-react";
import { apiFetch } from "@/lib/api";

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export default function JobsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useSWR("/jobs", (url: string) => apiFetch<any>(url));
  const jobs = (data?.data || []).filter((j: any) =>
    !search || j.title?.toLowerCase().includes(search.toLowerCase()) || j.department?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-12 animate-fadeInUp">
      {/* Hero */}
      <section className="relative text-center py-8 overflow-hidden">
        {/* Decorative background */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-[#5B4BF5]/[0.06] blur-[100px] pointer-events-none" />
        <div className="absolute top-20 right-0 w-[300px] h-[300px] rounded-full bg-[#F5D547]/[0.05] blur-[80px] pointer-events-none" />
        <div className="absolute top-40 left-0 w-[250px] h-[250px] rounded-full bg-[#3023D0]/[0.04] blur-[80px] pointer-events-none" />

        <div className="relative">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white text-xs font-semibold mb-6 animate-scaleIn shadow-[0_2px_12px_rgba(91,75,245,0.3)]">
            <Sparkles className="h-3.5 w-3.5 text-[#F5D547]" />
            We&apos;re Hiring
          </div>
          <h1 className="font-serif text-5xl md:text-6xl font-light text-[#1A1A1A] leading-[1.1] mb-4">
            Build Your Career at<br />
            <span className="gradient-text-warm font-normal">Digital Sukoon</span>
          </h1>
          <p className="text-[#7A7A7A] text-lg max-w-xl mx-auto leading-relaxed">
            Join India&apos;s fastest-growing digital marketing agency. Work on exciting brands, learn from the best, and grow your career.
          </p>
        </div>
      </section>

      {/* Internship Banner */}
      <Link href="/internship" className="group block max-w-3xl mx-auto animate-fadeInUp stagger-1">
        <div className="relative rounded-2xl border border-[#E8E0D0] bg-gradient-to-r from-[#F0EEFF] via-white to-[#FFF3C4] p-5 flex items-center gap-4 hover:shadow-[0_8px_32px_rgba(91,75,245,0.12)] hover:border-[#5B4BF5]/30 transition-all duration-300">
          <div className="shrink-0 h-12 w-12 rounded-xl bg-gradient-to-br from-[#5B4BF5] to-[#3023D0] flex items-center justify-center shadow-[0_4px_12px_rgba(91,75,245,0.3)]">
            <GraduationCap className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-semibold text-[#1A1A1A]">6-Month Internship Program</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-100 text-green-700 uppercase tracking-wide animate-pulse">Open</span>
            </div>
            <p className="text-sm text-[#7A7A7A]">Gain real-world experience in social media, content & design</p>
          </div>
          <ArrowRight className="h-5 w-5 text-[#B0B0B0] group-hover:text-[#5B4BF5] group-hover:translate-x-1 transition-all" />
        </div>
      </Link>

      {/* Search */}
      <div className="max-w-xl mx-auto animate-fadeInUp stagger-2">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-[#B0B0B0]" />
          <input
            type="text"
            placeholder="Search by role, department..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-12 pr-4 py-3.5 rounded-2xl border border-[#E8E0D0] bg-white/80 backdrop-blur-sm text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#5B4BF5]/30 focus:border-[#5B4BF5]/50 shadow-[0_2px_12px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_20px_rgba(91,75,245,0.08)] transition-all"
          />
        </div>
      </div>

      {/* Job Cards */}
      {isLoading ? (
        <div className="flex flex-col items-center py-16 gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#E8E0D0] border-t-[#F5D547]" />
          <p className="text-sm text-[#B0B0B0]">Loading opportunities...</p>
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16">
          <div className="h-16 w-16 rounded-2xl bg-[#FFF3C4] flex items-center justify-center mx-auto mb-4">
            <Briefcase className="h-7 w-7 text-[#B8960C]" />
          </div>
          <h3 className="text-lg font-semibold text-[#1A1A1A] mb-1">{search ? "No matching roles" : "No open positions"}</h3>
          <p className="text-sm text-[#7A7A7A]">{search ? "Try a different search term" : "Check back soon for new opportunities"}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-[#7A7A7A]">{jobs.length} Open Position{jobs.length !== 1 ? "s" : ""}</h2>
          </div>
          {jobs.map((job: any, i: number) => (
            <Link key={job.id} href={`/${job.id}`} className={`group block animate-fadeInUp stagger-${Math.min(i + 1, 6)}`}>
              <div className="relative rounded-2xl border border-[#E8E0D0] bg-white p-6 hover:border-[#5B4BF5]/30 hover:shadow-[0_8px_32px_rgba(91,75,245,0.08)] transition-all duration-300 overflow-hidden">
                {/* Accent line */}
                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#5B4BF5] to-[#F5D547] rounded-l-2xl opacity-0 group-hover:opacity-100 transition-opacity" />

                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-3">
                      <h3 className="text-xl font-semibold text-[#1A1A1A] group-hover:text-[#1A1A1A] transition-colors">{job.title}</h3>
                      {job.createdAt && (
                        <span className="text-xs text-[#B0B0B0] shrink-0">{timeAgo(job.createdAt)}</span>
                      )}
                    </div>

                    {/* Tags */}
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                      {job.department && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[#FFF3C4]/60 text-xs font-medium text-[#B8960C]">
                          <Building2 className="h-3 w-3" />{job.department}
                        </span>
                      )}
                      {job.location && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-50 text-xs font-medium text-blue-600">
                          <MapPin className="h-3 w-3" />{job.location}
                        </span>
                      )}
                      {job.type && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-50 text-xs font-medium text-green-700">
                          <Briefcase className="h-3 w-3" />{job.type}
                        </span>
                      )}
                      {(job.salaryMin || job.salaryMax) && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple-50 text-xs font-medium text-purple-700">
                          <IndianRupee className="h-3 w-3" />{job.salaryMin && job.salaryMax ? `${(job.salaryMin/100000).toFixed(1)}–${(job.salaryMax/100000).toFixed(1)} LPA` : job.salary || "Competitive"}
                        </span>
                      )}
                    </div>

                    {job.description && (
                      <p className="text-sm text-[#7A7A7A] line-clamp-2 leading-relaxed">{job.description.slice(0, 180)}{job.description.length > 180 ? "..." : ""}</p>
                    )}

                    {job.experience && (
                      <p className="text-xs text-[#B0B0B0] mt-2 flex items-center gap-1">
                        <Clock className="h-3 w-3" />{job.experience}
                      </p>
                    )}

                    {/* Apply Now button - responsive */}
                    <div className="mt-4 flex items-center gap-3">
                      <Link
                        href={`/${job.id}?apply=true`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white text-sm font-semibold shadow-[0_2px_8px_rgba(91,75,245,0.25)] hover:shadow-[0_4px_16px_rgba(91,75,245,0.35)] hover:-translate-y-0.5 transition-all"
                      >
                        <Send className="h-3.5 w-3.5" />
                        Apply Now
                      </Link>
                      <span className="text-xs text-[#B0B0B0] hidden sm:inline">or view details →</span>
                    </div>
                  </div>

                  <div className="shrink-0 hidden sm:flex h-10 w-10 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0] items-center justify-center text-[#B0B0B0] group-hover:bg-[#5B4BF5] group-hover:text-white group-hover:border-[#5B4BF5] transition-all duration-300">
                    <ChevronRight className="h-5 w-5" />
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
