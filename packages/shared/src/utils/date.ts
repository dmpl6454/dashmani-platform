const fmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    return fmt.format(new Date(value));
  } catch {
    return String(value);
  }
}
