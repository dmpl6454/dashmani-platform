export default function Loading() {
  return (
    <div className="pt-[26px] space-y-3.5" aria-hidden="true">
      <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-7 w-40 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-12 w-full max-w-[520px] rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-80 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
