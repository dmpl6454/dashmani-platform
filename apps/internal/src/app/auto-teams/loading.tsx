export default function Loading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-8 w-48 bg-rule rounded-xl" />
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-20 bg-rule rounded-xl" />
        ))}
      </div>
      <div className="h-80 bg-rule rounded-2xl" />
    </div>
  );
}
