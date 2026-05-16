/** Converts UPPER_SNAKE_CASE enum values to "Title Case" for display */
export function formatStatus(value: string): string {
  if (!value) return "";
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
