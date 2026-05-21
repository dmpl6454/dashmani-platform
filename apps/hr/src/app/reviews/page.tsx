"use client";

import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { Award, Star } from "lucide-react";

export default function ReviewsPage() {
  const { data } = useSWR("/hr/performance-reviews", apiFetch);
  const reviews = (data as any)?.data || [];

  return (
    <>
      <Topstrip title="Performance Reviews" sub="View your performance evaluations and feedback" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">

        {reviews.length === 0 ? (
          <div className="v3-card p-12 text-center">
            <Award className="h-9 w-9 mx-auto mb-3 text-ink-4" />
            <h3 className="text-[14px] font-semibold text-ink mb-1">No reviews yet</h3>
            <p className="text-[13px] text-ink-3 font-medium">Your performance reviews will appear here</p>
          </div>
        ) : (
          <div className="space-y-4">
            {reviews.map((review: any) => (
              <div key={review.id} className="v3-card">
                <div className="px-5 h-14 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <div>
                    <p className="text-[14px] font-semibold text-ink">{review.period}</p>
                    <p className="text-[11px] text-ink-4 font-medium mt-0.5">
                      Reviewed by {review.reviewer?.name || "Admin"} &middot;{" "}
                      {new Date(review.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star
                          key={s}
                          className={`h-4 w-4 ${s <= review.rating ? "fill-attention text-attention" : "text-ink-4"}`}
                        />
                      ))}
                    </div>
                    <span className="text-[13px] font-bold text-ink ml-1">{review.rating}/5</span>
                  </div>
                </div>

                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {review.strengths && (
                    <div className="bg-success-bg rounded-xl p-4 border border-success/15">
                      <p className="text-[11.5px] font-bold text-success uppercase tracking-wider mb-2">Strengths</p>
                      <p className="text-[13px] text-ink whitespace-pre-line leading-relaxed">{review.strengths}</p>
                    </div>
                  )}
                  {review.improvements && (
                    <div className="bg-attention-bg rounded-xl p-4 border border-attention/15">
                      <p className="text-[11.5px] font-bold text-attention uppercase tracking-wider mb-2">Areas for Improvement</p>
                      <p className="text-[13px] text-ink whitespace-pre-line leading-relaxed">{review.improvements}</p>
                    </div>
                  )}
                  {review.comments && (
                    <div className="bg-muted rounded-xl p-4 border border-ink/8">
                      <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-2">Comments</p>
                      <p className="text-[13px] text-ink whitespace-pre-line leading-relaxed">{review.comments}</p>
                    </div>
                  )}
                  {review.goals && (
                    <div className="bg-indigo-soft rounded-xl p-4 border border-indigo/15">
                      <p className="text-[11.5px] font-bold text-indigo uppercase tracking-wider mb-2">Goals for Next Period</p>
                      <p className="text-[13px] text-ink whitespace-pre-line leading-relaxed">{review.goals}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
