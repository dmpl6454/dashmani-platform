"use client";
import { API_BASE } from "@/lib/api";

const GRADIENTS = [
  "linear-gradient(135deg, #667eea, #764ba2)",
  "linear-gradient(135deg, #f093fb, #f5576c)",
  "linear-gradient(135deg, #4facfe, #00f2fe)",
  "linear-gradient(135deg, #43e97b, #38f9d7)",
  "linear-gradient(135deg, #fa709a, #fee140)",
  "linear-gradient(135deg, #a18cd1, #fbc2eb)",
];

function gradientFor(name: string) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
}

interface UserAvatarProps {
  name?: string | null;
  imageUrl?: string | null;
  /** Tailwind size class suffix (e.g. 8 → h-8 w-8). Default 10. */
  size?: number;
  /** Use a colored gradient for the initials fallback. Default true. */
  gradient?: boolean;
  /** Extra classes (e.g., ring-2 ring-white shadow-sm). */
  className?: string;
  /** Text size class for initials. Default text-sm. */
  textClassName?: string;
}

/**
 * Shared user avatar — renders profile image if available, else colored
 * gradient with first-letter initial. Handles relative (uploads/...) and
 * absolute URLs.
 */
export function UserAvatar({
  name,
  imageUrl,
  size = 10,
  gradient = true,
  className = "",
  textClassName = "text-sm",
}: UserAvatarProps) {
  const sizeClass = `h-${size} w-${size}`;
  const initial = (name || "?").charAt(0).toUpperCase();

  if (imageUrl) {
    const src = imageUrl.startsWith("http") ? imageUrl : `${API_BASE}${imageUrl}`;
    return (
      <img
        src={src}
        alt={name ?? ""}
        className={`${sizeClass} rounded-full object-cover shrink-0 ${className}`}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center text-white font-semibold shrink-0 ${textClassName} ${className}`}
      style={gradient ? { background: gradientFor(name ?? "") } : undefined}
    >
      {initial}
    </div>
  );
}
