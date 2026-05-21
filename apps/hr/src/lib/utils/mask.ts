/** Returns a masked version of a PII value, showing only the last `visibleLast` characters */
export function maskPII(value: string | null | undefined, visibleLast: number = 4): string {
  if (!value || value.trim() === "") return "";
  const v = value.trim();
  if (v.length <= visibleLast) return v;
  return "••••••" + v.slice(-visibleLast);
}
