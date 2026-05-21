/** Returns the Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns a similarity score in [0, 1] between two strings.
 * 1.0 = identical, 0.0 = completely different.
 */
export function stringSimilarity(a: string, b: string): number {
  const s = a.toLowerCase().trim(), t = b.toLowerCase().trim();
  if (s === t) return 1;
  const maxLen = Math.max(s.length, t.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(s, t) / maxLen;
}
