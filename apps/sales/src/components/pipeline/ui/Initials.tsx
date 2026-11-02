"use client";
/** Initials avatar, coloured by a hash of the user id (stable across renames). */
const COLORS = ["#5D5FEF", "#4A7C52", "#C05826", "#8BA888", "#E07A5F", "#4547D4", "#6C6555", "#B83728"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const a = Array.from(parts[0])[0] ?? "";
  const b = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";
  return (a + b).toUpperCase();
}

export function Initials({
  userId,
  name,
  initials,
  size = 28,
  title,
  className = "",
}: {
  userId: string;
  name?: string | null;
  initials?: string | null;
  size?: number;
  title?: string;
  className?: string;
}) {
  const text = initials || (name ? initialsOf(name) : "?");
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={`inline-grid place-items-center rounded-full text-white font-bold select-none ${className}`}
      style={{
        width: size,
        height: size,
        minWidth: size,
        fontSize: Math.max(10, Math.round(size * 0.38)),
        background: COLORS[hash(userId) % COLORS.length],
      }}
    >
      {text}
    </span>
  );
}
