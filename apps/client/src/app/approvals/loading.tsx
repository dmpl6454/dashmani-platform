export default function Loading() {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Inbox list */}
      <div className="w-[340px] border-r border-rule flex flex-col">
        <div className="px-4 py-3 border-b border-rule">
          <div className="h-6 w-28 bg-muted rounded animate-pulse" />
        </div>
        {[...Array(5)].map((_, i) => (
          <div key={i} className="px-4 py-3 border-b border-rule space-y-1.5">
            <div className="h-3.5 w-3/4 bg-muted rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
          </div>
        ))}
      </div>
      {/* Detail panel */}
      <div className="flex-1 p-6 space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="h-64 bg-muted rounded-lg animate-pulse" />
        <div className="flex gap-2">
          <div className="h-9 w-24 bg-muted rounded animate-pulse" />
          <div className="h-9 w-24 bg-muted rounded animate-pulse" />
        </div>
      </div>
    </div>
  );
}
