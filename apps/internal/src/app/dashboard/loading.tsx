export default function Loading() {
  return (
    <div className="pt-[22px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-32 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-7 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-[104px] rounded-[6px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="grid gap-3.5 grid-cols-1 xl:grid-cols-3">
        <div className="xl:col-span-2 h-[300px] rounded-[6px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
        <div className="h-[300px] rounded-[6px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
