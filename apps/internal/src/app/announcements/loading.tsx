export default function Loading() {
  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="h-8 w-56 bg-gray-200 rounded animate-pulse" />
        <div className="h-10 w-44 bg-gray-200 rounded-full animate-pulse" />
      </div>
      <div className="h-64 bg-gray-100 rounded-2xl animate-pulse" />
    </div>
  );
}
