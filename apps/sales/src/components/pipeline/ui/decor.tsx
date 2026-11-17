/**
 * Decorative drawings for the Pipeline (no state, no data). Brand indigo is #403CFA, the
 * grey is ink-4 (#5C5C66); both are hard-coded because SVG fills don't read Tailwind tokens.
 */

/** Two chat bubbles: the empty-conversation picture. */
export function ChatBubblesArt() {
  return (
    <svg width="156" height="128" viewBox="0 0 156 128" fill="none" aria-hidden>
      <path d="M120 2 L114 14 M134 8 L124 18 M138 24 L126 24" stroke="#403CFA" strokeWidth="3" strokeLinecap="round" />
      <rect x="62" y="50" width="88" height="62" rx="14" stroke="#5C5C66" strokeWidth="3" />
      <path d="M126 112 L136 124 L136 112" stroke="#5C5C66" strokeWidth="3" strokeLinejoin="round" />
      <rect x="4" y="22" width="104" height="68" rx="16" fill="#403CFA" />
      <path d="M20 90 L12 106 L34 90 Z" fill="#403CFA" />
      <circle cx="36" cy="56" r="6" fill="#fff" />
      <circle cx="56" cy="56" r="6" fill="#fff" />
      <circle cx="76" cy="56" r="6" fill="#fff" />
    </svg>
  );
}

/** A soft indigo wave pinned to the bottom of its (relative) parent; never takes clicks. */
export function WaveGlow() {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[220px] w-full" viewBox="0 0 1000 220" preserveAspectRatio="none">
      <defs>
        <linearGradient id="pl-wave" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#403CFA" stopOpacity="0.32" />
          <stop offset="1" stopColor="#403CFA" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <path d="M0 90 C 180 40, 330 150, 520 120 S 860 10, 1000 40 L 1000 220 L 0 220 Z" fill="url(#pl-wave)" />
    </svg>
  );
}
