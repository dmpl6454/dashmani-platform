import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface ProviderCost {
  provider: string;
  calls: number;
  units: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSheet {
  windowDays: number;
  since: string;
  totalCostUsd: number;
  byProvider: ProviderCost[];
  byOperation: Array<{ provider: string; operation: string; calls: number; costUsd: number }>;
  daily: Array<{ date: string; costUsd: number; calls: number }>;
  projectedMonthlyUsd: number;
  projectedDailyUsd: number;
  // Horizon honesty (optional — absent on older API responses)
  trackingSince?: string | null;
  effectiveDays?: number;
  fullWindow?: boolean;
  hasReconstructed?: boolean;
  projectionReliable?: boolean;
  pendingExtractionBacklog?: number;
}

export function useCostSheet(days = 30) {
  return useSWR(`/admin/api-usage/cost-sheet?days=${days}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 120_000,
  });
}
