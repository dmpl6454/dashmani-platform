export default function Loading() {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        <div className="h-8 w-56 bg-muted rounded animate-pulse" />
        <div className="h-72 bg-muted rounded-lg animate-pulse" />
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-4 bg-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
      {/* Sidebar */}
      <div className="w-80 border-l border-rule p-4 space-y-3">
        <div className="h-6 w-32 bg-muted rounded animate-pulse" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />
        ))}
      </div>
    </div>
  );
}
