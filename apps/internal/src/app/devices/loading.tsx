export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-9 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="h-[104px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
      </div>
      <div className="h-80 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
