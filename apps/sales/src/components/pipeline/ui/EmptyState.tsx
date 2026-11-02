"use client";
export function EmptyState({ title, body, action }: { title: string; body?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-2 px-6 py-10">
      <p className="text-[15px] font-bold text-ink">{title}</p>
      {body && <div className="text-[13px] text-ink-3 max-w-sm">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
