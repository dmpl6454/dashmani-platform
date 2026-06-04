export default function Loading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-56 bg-rule rounded-xl" />
      <div className="h-24 bg-rule rounded-2xl" />
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-32 bg-rule rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
