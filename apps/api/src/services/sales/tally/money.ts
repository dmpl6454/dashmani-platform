// Exact money splitting for Tally (spec-tally §4.4). einvoice.service.ts's float `apportion` is
// deliberately NOT reused: it is inexact above ~2^53 products and sits on the live IRN path.

/**
 * Split `total` paise across `weights` (e.g. line amounts grouped by sales ledger) in proportion,
 * exactly: BigInt floor shares, then the leftover paise go to the largest fractional parts, ties
 * to the earlier weight. The shares always sum to `total`. All-zero weights put everything on the
 * first entry.
 */
export function splitExact(total: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new Error("splitExact needs integer paise");
  if (!weights.length) return [];
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new Error("splitExact needs non-negative integer weights");
  const sign = total < 0 ? -1n : 1n;
  const T = BigInt(Math.abs(total));
  const W = weights.map((w) => BigInt(w));
  const sumW = W.reduce((s, w) => s + w, 0n);
  if (sumW === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  const floors = W.map((w) => (T * w) / sumW);
  const rems = W.map((w) => (T * w) % sumW);
  let left = T - floors.reduce((s, f) => s + f, 0n);
  const order = rems.map((r, i) => ({ r, i })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left <= 0n) break;
    floors[i] += 1n;
    left -= 1n;
  }
  return floors.map((f) => Number(f * sign));
}
