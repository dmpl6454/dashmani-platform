export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-11 w-72 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-12 w-full max-w-[760px] rounded-full bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-[460px] rounded-[18px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
    </div>
  );
}
