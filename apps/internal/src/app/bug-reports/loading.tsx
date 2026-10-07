export default function Loading() {
  return (
    <div className="pt-[30px] space-y-3.5" aria-hidden="true">
      <div className="h-9 w-64 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
      <div className="h-11 w-[420px] max-w-full rounded-full bg-ds-hover motion-safe:animate-pulse" />
      {[...Array(3)].map((_, i) => <div key={i} className="h-[120px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
    </div>
  );
}
