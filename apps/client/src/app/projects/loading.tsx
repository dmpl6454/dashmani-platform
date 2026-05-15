export default function Loading() {
  return (
    <div className="px-6 py-5 max-w-[1200px] mx-auto w-full space-y-4">
      <div className="h-8 w-36 bg-muted rounded animate-pulse" />
      <div className="flex gap-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-8 w-20 bg-muted rounded-md animate-pulse" />
        ))}
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 h-[52px] border-b border-rule last:border-b-0">
            <div className="h-3.5 flex-1 bg-muted rounded animate-pulse" />
            <div className="h-5 w-16 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
            <div className="h-1.5 w-24 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
