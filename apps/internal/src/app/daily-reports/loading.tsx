export default function Loading() {
  return (
    <div className="pt-[26px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-12 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-7 w-48 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-[170px] rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))]">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-52 rounded-[10px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}
