export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-2.5">
          <div className="h-9 w-56 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-3.5 w-48 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        </div>
        <div className="h-[46px] w-52 rounded-full bg-ds-hover motion-safe:animate-pulse" />
      </div>
      <div className="h-80 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
