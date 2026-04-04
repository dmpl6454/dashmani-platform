export interface PaginationParams {
  cursor?: string;
  limit: number;
}

export function parsePagination(query: Record<string, unknown>): PaginationParams {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  return { cursor, limit };
}

export function buildPaginationMeta(items: { id: string }[], limit: number) {
  const hasMore = items.length > limit;
  const trimmed = hasMore ? items.slice(0, limit) : items;
  return {
    items: trimmed,
    meta: {
      cursor: trimmed.length > 0 ? trimmed[trimmed.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}
