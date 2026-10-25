export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-9 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-[52px] w-[360px] max-w-full rounded-full bg-ds-inset border border-ds-line2 motion-safe:animate-pulse" />
      <div className="rounded-[18px] bg-ds-card border border-[color:var(--hx-2A4658)] overflow-hidden">
        <div className="h-[118px] border-b border-[color:var(--hx-1A2C38)] motion-safe:animate-pulse" />
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-6 py-[18px] border-b border-[color:var(--hx-132430)] last:border-b-0">
            <div className="h-11 w-11 rounded-full bg-ds-hover motion-safe:animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-40 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
              <div className="h-3 w-56 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
