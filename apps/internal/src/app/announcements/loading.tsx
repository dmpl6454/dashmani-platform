export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-24 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-9 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-3.5 w-80 max-w-full rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-[420px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
