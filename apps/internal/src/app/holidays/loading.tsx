export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-2.5">
          <div className="h-3 w-20 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-10 w-72 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-3.5 w-52 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        </div>
        <div className="h-11 w-64 max-w-full rounded-full bg-ds-hover motion-safe:animate-pulse" />
      </div>
      <div className="h-[150px] rounded-[20px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      {[...Array(3)].map((_, i) => (
        <div key={i} className="h-[120px] rounded-[18px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
