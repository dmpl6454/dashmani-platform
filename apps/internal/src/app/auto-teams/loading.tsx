export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-20 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-10 w-72 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-96 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
        {[...Array(4)].map((_, i) => <div key={i} className="h-[360px] rounded-[18px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
      </div>
    </div>
  );
}
