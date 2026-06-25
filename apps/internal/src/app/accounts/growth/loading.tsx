export default function Loading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-48 bg-rule rounded-xl" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 bg-rule rounded-2xl" />
        ))}
      </div>
      <div className="h-64 bg-rule rounded-2xl" />
      <div className="h-80 bg-rule rounded-2xl" />
    </div>
  );
}
