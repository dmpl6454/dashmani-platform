"use client";

import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Award, Star } from "lucide-react";

export default function ReviewsPage() {
  const { data } = useSWR("/hr/performance-reviews", apiFetch);
  const reviews = (data as any)?.data || [];

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-6">
      <div>
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Performance Reviews</h1>
        <p className="text-sm text-[#888] mt-1">View your performance evaluations and feedback</p>
      </div>

      {reviews.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center">
          <Award className="h-10 w-10 mx-auto mb-3 text-[#C4B89C]" />
          <h3 className="text-lg font-semibold text-[#1A1A1A] mb-1">No reviews yet</h3>
          <p className="text-sm text-[#888]">Your performance reviews will appear here</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((review: any) => (
            <div key={review.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-[#1A1A1A]">{review.period}</h3>
                  <p className="text-xs text-[#888]">Reviewed by {review.reviewer?.name || "Admin"} · {new Date(review.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    {[1,2,3,4,5].map((s) => (
                      <Star key={s} className={`h-5 w-5 ${s <= review.rating ? "fill-[#F5D547] text-[#F5D547]" : "text-[#E8E0D0]"}`} />
                    ))}
                  </div>
                  <span className="text-lg font-bold text-[#1A1A1A] ml-2">{review.rating}/5</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                {review.strengths && (
                  <div className="bg-green-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-2">Strengths</p>
                    <p className="text-green-800 whitespace-pre-line">{review.strengths}</p>
                  </div>
                )}
                {review.improvements && (
                  <div className="bg-orange-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-orange-700 uppercase tracking-wider mb-2">Areas for Improvement</p>
                    <p className="text-orange-800 whitespace-pre-line">{review.improvements}</p>
                  </div>
                )}
                {review.comments && (
                  <div className="bg-[#FEFCF7] rounded-xl p-4 border border-[#E8E0D0]">
                    <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wider mb-2">Comments</p>
                    <p className="text-[#1A1A1A] whitespace-pre-line">{review.comments}</p>
                  </div>
                )}
                {review.goals && (
                  <div className="bg-blue-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-2">Goals for Next Period</p>
                    <p className="text-blue-800 whitespace-pre-line">{review.goals}</p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
