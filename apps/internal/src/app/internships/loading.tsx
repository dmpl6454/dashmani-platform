export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-20 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-10 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-72 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="flex gap-1.5 overflow-hidden">
        {[...Array(6)].map((_, i) => <div key={i} className="h-[38px] w-24 shrink-0 rounded-full bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
      </div>
      <div className="h-[420px] rounded-[18px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
