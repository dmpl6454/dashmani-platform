export default function Loading() {
  return (
    <div className="pt-[26px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-12 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-7 w-52 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-[180px] rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      <div className="h-[34px] w-72 max-w-full rounded-full bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-80 rounded-[10px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
