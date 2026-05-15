export default function Loading() {
  return (
    <div className="p-6 space-y-6 max-w-[1200px] mx-auto w-full">
      <div className="h-8 w-48 bg-muted rounded animate-pulse" />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          <div className="h-48 bg-muted rounded-lg animate-pulse" />
          <div className="h-64 bg-muted rounded-lg animate-pulse" />
        </div>
        <div className="h-96 bg-muted rounded-lg animate-pulse" />
      </div>
    </div>
  );
}
