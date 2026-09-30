import type { Config } from "tailwindcss";

/* Every colour resolves to a CSS variable in the `R G B` channel form
   (`rgb(var(--t-x) / <alpha-value>)`) so Tailwind's `/opacity` modifiers keep
   working AND the whole palette flips via `data-theme` on <html> (see
   src/app/globals.css). Light + dark are two modes of the SAME system; the
   sky/purple accent hues are shared across both. The 200-500 rungs of the
   status scales are intentionally NOT listed so Tailwind's defaults fill them
   (they read on both themes for dots/icons), exactly as before. */
const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:      rgb("--t-bg"),
        surface: rgb("--t-surface"),
        muted:   rgb("--t-muted"),
        rule:    rgb("--t-rule"),
        border:  rgb("--t-border"),
        ink: {
          DEFAULT: rgb("--t-ink"),
          2: rgb("--t-ink-2"),
          3: rgb("--t-ink-3"),
          4: rgb("--t-ink-4"),
        },
        action: {
          DEFAULT: rgb("--t-action"),
          soft:    rgb("--t-action-soft"),
          deep:    rgb("--t-action-deep"),
          ring:    "rgb(var(--t-action) / 0.32)",
        },
        neutral:   { DEFAULT: rgb("--t-neutral"),   bg: rgb("--t-neutral-bg") },
        attention: { DEFAULT: rgb("--t-attention"), bg: rgb("--t-attention-bg") },
        success:   { DEFAULT: rgb("--t-success"),   bg: rgb("--t-success-bg") },
        danger:    { DEFAULT: rgb("--t-danger"),    bg: rgb("--t-danger-bg") },
        /* indigo = the portal's dominant accent slot (mapped to the design's sky).
           Keeps the 50/100/600-900 rungs (shared with blue/sky) so bg-indigo-700
           etc. still resolve, and merges with Tailwind's default indigo scale. */
        indigo: {
          DEFAULT: rgb("--t-indigo"), soft: rgb("--t-indigo-soft"), deep: rgb("--t-indigo-deep"),
          50: rgb("--t-blue-50"), 100: rgb("--t-blue-100"), 600: rgb("--t-blue-600"),
          700: rgb("--t-blue-700"), 800: rgb("--t-blue-800"), 900: rgb("--t-blue-900"),
        },
        sage:  { DEFAULT: rgb("--t-sage"),  soft: rgb("--t-sage-soft") },
        terra: { DEFAULT: rgb("--t-terra"), soft: rgb("--t-terra-soft") },
        gold:  { DEFAULT: rgb("--t-gold"),  soft: rgb("--t-gold-soft") },

        /* ── Status default scales (50/100 = background, 600-900 = text; both
           flip with the theme). Aliased families share one variable set. ── */
        red:     { 50: rgb("--t-red-50"),    100: rgb("--t-red-100"),    600: rgb("--t-red-600"),    700: rgb("--t-red-700"),    800: rgb("--t-red-800"),    900: rgb("--t-red-900") },
        rose:    { 50: rgb("--t-red-50"),    100: rgb("--t-red-100"),    600: rgb("--t-red-600"),    700: rgb("--t-red-700"),    800: rgb("--t-red-800"),    900: rgb("--t-red-900") },
        orange:  { 50: rgb("--t-orange-50"), 100: rgb("--t-orange-100"), 600: rgb("--t-orange-600"), 700: rgb("--t-orange-700"), 800: rgb("--t-orange-800"), 900: rgb("--t-orange-900") },
        amber:   { 50: rgb("--t-amber-50"),  100: rgb("--t-amber-100"),  600: rgb("--t-amber-600"),  700: rgb("--t-amber-700"),  800: rgb("--t-amber-800"),  900: rgb("--t-amber-900") },
        yellow:  { 50: rgb("--t-yellow-50"), 100: rgb("--t-yellow-100"), 600: rgb("--t-yellow-600"), 700: rgb("--t-yellow-700"), 800: rgb("--t-yellow-800"), 900: rgb("--t-yellow-900") },
        green:   { 50: rgb("--t-green-50"),  100: rgb("--t-green-100"),  600: rgb("--t-green-600"),  700: rgb("--t-green-700"),  800: rgb("--t-green-800"),  900: rgb("--t-green-900") },
        emerald: { 50: rgb("--t-green-50"),  100: rgb("--t-green-100"),  600: rgb("--t-green-600"),  700: rgb("--t-green-700"),  800: rgb("--t-green-800"),  900: rgb("--t-green-900") },
        teal:    { 50: rgb("--t-teal-50"),   100: rgb("--t-teal-100"),   600: rgb("--t-teal-600"),   700: rgb("--t-teal-700"),   800: rgb("--t-teal-800"),   900: rgb("--t-teal-900") },
        lime:    { 50: rgb("--t-lime-50"),   100: rgb("--t-lime-100"),   600: rgb("--t-lime-600"),   700: rgb("--t-lime-700"),   800: rgb("--t-lime-800"),   900: rgb("--t-lime-900") },
        blue:    { 50: rgb("--t-blue-50"),   100: rgb("--t-blue-100"),   600: rgb("--t-blue-600"),   700: rgb("--t-blue-700"),   800: rgb("--t-blue-800"),   900: rgb("--t-blue-900") },
        sky:     { 50: rgb("--t-blue-50"),   100: rgb("--t-blue-100"),   600: rgb("--t-blue-600"),   700: rgb("--t-blue-700"),   800: rgb("--t-blue-800"),   900: rgb("--t-blue-900") },
        cyan:    { 50: rgb("--t-cyan-50"),   100: rgb("--t-cyan-100"),   600: rgb("--t-cyan-600"),   700: rgb("--t-cyan-700"),   800: rgb("--t-cyan-800"),   900: rgb("--t-cyan-900") },
        purple:  { 50: rgb("--t-purple-50"), 100: rgb("--t-purple-100"), 600: rgb("--t-purple-600"), 700: rgb("--t-purple-700"), 800: rgb("--t-purple-800"), 900: rgb("--t-purple-900") },
        violet:  { 50: rgb("--t-purple-50"), 100: rgb("--t-purple-100"), 600: rgb("--t-purple-600"), 700: rgb("--t-purple-700"), 800: rgb("--t-purple-800"), 900: rgb("--t-purple-900") },

        /* ── Neutral default scales → theme tokens. Pages still use bg-gray-100 /
           text-gray-700 / border-gray-200 style chips; left as Tailwind defaults they
           are fixed LIGHT colours and glare on the dark theme. 300-500 keep defaults
           (mid-greys read on both). ── */
        gray:  { 50: rgb("--t-muted"), 100: rgb("--t-muted"), 200: rgb("--t-border"), 600: rgb("--t-ink-3"), 700: rgb("--t-ink-2"), 800: rgb("--t-ink"), 900: rgb("--t-ink") },
        slate: { 50: rgb("--t-muted"), 100: rgb("--t-muted"), 200: rgb("--t-border"), 600: rgb("--t-ink-3"), 700: rgb("--t-ink-2"), 800: rgb("--t-ink"), 900: rgb("--t-ink") },

        /* ── Legacy aliases (theme-driven) ── */
        background: rgb("--t-bg"),
        foreground: rgb("--t-ink"),
        brand: {
          yellow:         rgb("--t-action"),
          "yellow-light": rgb("--t-action-soft"),
          "yellow-muted": rgb("--t-action-soft"),
          purple:         rgb("--t-action"),
          "purple-deep":  rgb("--t-action-deep"),
          "purple-light": rgb("--t-action-soft"),
          dark:           rgb("--t-surface"),
          "dark-card":    rgb("--t-border"),
          cream:          rgb("--t-bg"),
        },
        sidebar: {
          DEFAULT:    rgb("--t-sidebar"),
          foreground: rgb("--t-ink"),
          accent:     rgb("--t-muted"),
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
        card:         'var(--t-shadow-card)',
        'card-lg':    'var(--t-shadow-card-lg)',
        pop:          'var(--t-shadow-pop)',
        hard:         'var(--t-shadow-hard)',
        'hard-hover': 'var(--t-shadow-hard-hover)',
        'hard-ink':   'var(--t-shadow-hard-ink)',
        focus:        'var(--t-shadow-focus)',
        btn:          'var(--t-shadow-btn)',
        'btn-hover':  'var(--t-shadow-btn-hover)',
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
