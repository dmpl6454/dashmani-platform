import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ──────────────────────────────────────────────────────────────
           DARK NAVY THEME — mapped from the "Dashboard.dc.html" design.
           Portal was previously a cream/light theme; these tokens flip the
           whole shell + every token-driven page to dark. The /overview page
           is a self-contained dark plane (its own overview.css) and is NOT
           affected by anything in this file.
           Primary accent = sky #38BDF8 (design's lead interactive colour).
           ────────────────────────────────────────────────────────────── */
        bg:      '#060D14',   /* page background            (design body)   */
        surface: '#0C151F',   /* card surface               (design card)   */
        muted:   '#0B1720',   /* secondary surface / inputs / hover         */
        rule:    '#131E28',   /* subtle divider                             */
        border:  '#1C2A38',   /* default border                             */
        /* `ink` is now the FOREGROUND (light) — it was near-black before.
           text-ink* reads on the dark surfaces. Opacity uses (border-ink/10,
           bg-ink/5) become subtle light tints, which is correct on dark.
           The two OPAQUE idioms that relied on ink being dark — `bg-ink
           text-white` (primary buttons) and `bg-ink/40` (scrims) — are
           re-mapped in the compat sweep, not here. */
        ink: { DEFAULT: '#F4F6F8', 2: '#A7B3C2', 3: '#738395', 4: '#6B7A8A' },
        action: {
          DEFAULT: '#38BDF8',
          soft:   '#10222E',
          deep:   '#5CCBFF',
          ring:   'rgba(56,189,248,.32)',
        },
        neutral:   { DEFAULT: '#738395', bg: '#0B1720' },
        attention: { DEFAULT: '#FBBF24', bg: '#2A2410' },
        success:   { DEFAULT: '#34D399', bg: '#0E2A22' },
        danger:    { DEFAULT: '#FB7185', bg: '#2A1116' },
        /* indigo is the portal's dominant accent slot → mapped to the design's
           lead sky. Kept as an object that MERGES with Tailwind's default
           indigo scale (below), so both bg-indigo (sky) and any bg-indigo-700
           keep working. */
        indigo:    { DEFAULT: '#38BDF8', soft: '#10222E', deep: '#7DD3FC',
                     50: '#10222E', 100: '#16303E', 600: '#38BDF8', 700: '#7DD3FC', 800: '#7DD3FC', 900: '#BAE6FD' },
        sage:      { DEFAULT: '#34D399', soft: '#0E2A22' },
        terra:     { DEFAULT: '#9B7EDE', soft: '#1B1630' },
        gold:      { DEFAULT: '#E9BD62', soft: '#241E12' },

        /* ── Tailwind default pastel scales, re-tuned for dark ──
           In this codebase the 50/100 rungs are used ONLY as backgrounds and
           the 600–900 rungs ONLY as text (verified), so flipping 50/100 → dark
           tint and 600–900 → light shade re-themes every status chip
           (`bg-red-50 text-red-700` …) with no per-file edits and no conflict.
           400/500 (saturated mids) are left as Tailwind defaults — they read
           fine on dark for dots/icons. `extend` merges, so untouched rungs
           keep their defaults. */
        red:     { 50: '#2A1116', 100: '#3A1620', 600: '#FB7185', 700: '#F87186', 800: '#FCA5B4', 900: '#FECDD6' },
        rose:    { 50: '#2A1116', 100: '#3A1620', 600: '#FB7185', 700: '#FB7185', 800: '#FDA4B4', 900: '#FECDD6' },
        orange:  { 50: '#2A1B10', 100: '#3A2616', 600: '#FBA94C', 700: '#FBBF24', 800: '#FCD34D', 900: '#FDE68A' },
        amber:   { 50: '#2A2410', 100: '#3A3216', 600: '#FBBF24', 700: '#FBBF24', 800: '#FCD34D', 900: '#FDE68A' },
        yellow:  { 50: '#2A2410', 100: '#3A3216', 600: '#E9BD62', 700: '#E9BD62', 800: '#F1D08A', 900: '#F7E3B5' },
        green:   { 50: '#0E2A22', 100: '#123A2E', 600: '#34D399', 700: '#34D399', 800: '#6EE7B7', 900: '#A7F3D0' },
        emerald: { 50: '#0E2A22', 100: '#123A2E', 600: '#34D399', 700: '#34D399', 800: '#6EE7B7', 900: '#A7F3D0' },
        teal:    { 50: '#0E2A28', 100: '#123A36', 600: '#2DD4BF', 700: '#2DD4BF', 800: '#5EEAD4', 900: '#99F6E4' },
        lime:    { 50: '#1E2A10', 100: '#2A3A16', 600: '#A3E635', 700: '#A3E635', 800: '#BEF264', 900: '#D9F99D' },
        blue:    { 50: '#10222E', 100: '#16303E', 600: '#38BDF8', 700: '#38BDF8', 800: '#7DD3FC', 900: '#BAE6FD' },
        sky:     { 50: '#10222E', 100: '#16303E', 600: '#38BDF8', 700: '#38BDF8', 800: '#7DD3FC', 900: '#BAE6FD' },
        cyan:    { 50: '#0E2A2E', 100: '#123A3E', 600: '#22D3EE', 700: '#22D3EE', 800: '#67E8F9', 900: '#A5F3FC' },
        purple:  { 50: '#1B1630', 100: '#241B40', 600: '#9B7EDE', 700: '#9B7EDE', 800: '#C4B5FD', 900: '#DDD6FE' },
        violet:  { 50: '#1B1630', 100: '#241B40', 600: '#9B7EDE', 700: '#9B7EDE', 800: '#C4B5FD', 900: '#DDD6FE' },

        /* ── Legacy aliases (retinted to the dark palette) ── */
        background: '#060D14',
        foreground: '#F4F6F8',
        brand: {
          yellow:       '#38BDF8',
          'yellow-light': '#10222E',
          'yellow-muted': '#12212B',
          purple:       '#38BDF8',
          'purple-deep':  '#5CCBFF',
          'purple-light': '#10222E',
          dark:         '#0C151F',
          'dark-card':    '#1D2C3A',
          cream:        '#060D14',
        },
        sidebar: {
          DEFAULT: '#050A10',
          foreground: '#F4F6F8',
          accent: '#0B1720',
        },
      },
      fontFamily: {
        sans:  ["'Instagram Sans'", 'system-ui', 'sans-serif'],
        serif: ['Fraunces', 'Georgia', 'serif'],
      },
      borderRadius: {
        DEFAULT: '12px',
        sm:  '8px',
        md:  '14px',
        lg:  '20px',
        xl:  '24px',
        '2xl': '28px',
        full: '999px',
        pill: '999px',
      },
      boxShadow: {
        /* Soft depth shadows (design uses soft drop shadows on dark cards,
           not the old hard indigo offsets which are invisible on dark). */
        card:         '0 10px 26px rgba(0,0,0,.35)',
        'card-lg':    '0 14px 34px rgba(0,0,0,.45)',
        pop:          '0 16px 48px rgba(0,0,0,.55)',
        hard:         '0 8px 22px rgba(0,0,0,.40)',
        'hard-hover': '0 12px 30px rgba(0,0,0,.50)',
        'hard-ink':   '0 6px 18px rgba(0,0,0,.40)',
        focus:        '0 0 0 3px rgba(56,189,248,.28)',
        /* Buttons keep the offset "pop" idiom, recoloured for dark. */
        btn:          '3px 3px 0 rgba(0,0,0,.55)',
        'btn-hover':  '4px 4px 0 rgba(0,0,0,.55)',
      },
      spacing: {
        rail:  '220px',
        railc: '58px',
        row:   '48px',
        rowc:  '44px',
      },
    },
  },
  plugins: [],
};

export default config;
