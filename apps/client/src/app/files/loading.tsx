export default function Loading() {
  return (
    <div className="px-6 py-4">
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <div className="h-10 bg-muted/30 border-b border-rule animate-pulse" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 h-[52px] border-b border-rule last:border-b-0">
            <div className="h-7 w-7 bg-muted rounded animate-pulse shrink-0" />
            <div className="h-3.5 flex-1 bg-muted rounded animate-pulse" />
            <div className="h-5 w-24 bg-muted rounded animate-pulse" />
            <div className="h-3 w-12 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
            <div className="h-6 w-6 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
