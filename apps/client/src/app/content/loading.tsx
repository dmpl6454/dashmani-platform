export default function Loading() {
  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex gap-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-8 w-24 bg-muted rounded-md animate-pulse" />
        ))}
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 h-[60px] border-b border-rule last:border-b-0">
            <div className="h-9 w-9 bg-muted rounded animate-pulse shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-2/3 bg-muted rounded animate-pulse" />
              <div className="h-3 w-1/3 bg-muted rounded animate-pulse" />
            </div>
            <div className="h-5 w-16 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
