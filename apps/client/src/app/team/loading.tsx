import { Skeleton } from "@/components/portal-shared";

export default function Loading() {
  return (
    <div className="px-4 sm:px-6 py-6 max-w-3xl space-y-2">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
    </div>
  );
}
