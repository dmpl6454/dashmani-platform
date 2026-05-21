/** Converts a name string to Title Case (each word capitalised). */
export function toTitleCase(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
