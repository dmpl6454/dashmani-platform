import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ── v3 Zen-Brutalist tokens ── */
        bg:      '#FDFCF0',
        surface: '#FFFFFF',
        muted:   '#F3EED8',
        rule:    '#EDE7D2',
        border:  '#D4CBBA',
        ink: { DEFAULT: '#1A1A1A', 2: '#3A3A3A', 3: '#6C6555', 4: '#9C947C' },
        action: {
          DEFAULT: '#F5D547',
          soft:   '#FFF3C4',
          deep:   '#E8C83A',
          ring:   'rgba(245,213,71,.32)',
        },
        neutral:   { DEFAULT: '#6C6555', bg: '#F0EAD8' },
        attention: { DEFAULT: '#C05826', bg: '#FDF0EC' },
        success:   { DEFAULT: '#4A7C52', bg: '#EDF4EE' },
        danger:    { DEFAULT: '#B83728', bg: '#FDECEA' },
        indigo:    { DEFAULT: '#5D5FEF', soft: '#EDEDFD', deep: '#4547D4' },
        sage:      { DEFAULT: '#8BA888', soft: '#EEF4ED' },
        terra:     { DEFAULT: '#E07A5F', soft: '#FDF0EC' },

        /* ── Premium dark redesign ("ds") — used only by redesigned routes,
              see DS_ROUTES in src/lib/ds-routes.ts. ── */
        // Values live in globals.css as RGB triplets (--ds-<name>), switched by
        // html[data-theme] — dark is the default and is byte-identical to the original
        // hex values; light is the cream palette. `<alpha-value>` keeps /opacity working.
        ds: {
          bg: 'rgb(var(--ds-bg) / <alpha-value>)',
          rail: 'rgb(var(--ds-rail) / <alpha-value>)',
          card: 'rgb(var(--ds-card) / <alpha-value>)',
          inset: 'rgb(var(--ds-inset) / <alpha-value>)',
          hover: 'rgb(var(--ds-hover) / <alpha-value>)',
          grid: 'rgb(var(--ds-grid) / <alpha-value>)',
          chip: 'rgb(var(--ds-chip) / <alpha-value>)',
          line: 'rgb(var(--ds-line) / <alpha-value>)',
          line2: 'rgb(var(--ds-line2) / <alpha-value>)',
          line3: 'rgb(var(--ds-line3) / <alpha-value>)',
          line4: 'rgb(var(--ds-line4) / <alpha-value>)',
          text: 'rgb(var(--ds-text) / <alpha-value>)',
          t2: 'rgb(var(--ds-t2) / <alpha-value>)',
          t3: 'rgb(var(--ds-t3) / <alpha-value>)',
          t4: 'rgb(var(--ds-t4) / <alpha-value>)',
          t5: 'rgb(var(--ds-t5) / <alpha-value>)',
          gold: 'rgb(var(--ds-gold) / <alpha-value>)',
          gold2: 'rgb(var(--ds-gold2) / <alpha-value>)',
          golddeep: 'rgb(var(--ds-golddeep) / <alpha-value>)',
          teal: 'rgb(var(--ds-teal) / <alpha-value>)',
          blue: 'rgb(var(--ds-blue) / <alpha-value>)',
          red: 'rgb(var(--ds-red) / <alpha-value>)',
          redsoft: 'rgb(var(--ds-redsoft) / <alpha-value>)',
          purple: 'rgb(var(--ds-purple) / <alpha-value>)',
          green: 'rgb(var(--ds-green) / <alpha-value>)',
          pink: 'rgb(var(--ds-pink) / <alpha-value>)',
          fb: 'rgb(var(--ds-fb) / <alpha-value>)',
          ig: 'rgb(var(--ds-ig) / <alpha-value>)',
          yt: 'rgb(var(--ds-yt) / <alpha-value>)',
          sc: 'rgb(var(--ds-sc) / <alpha-value>)',
        },

        /* ── Legacy aliases ── */
        background: '#FDFCF0',
        foreground: '#1A1A1A',
        brand: {
          yellow:       '#F5D547',
          'yellow-light': '#FFF3C4',
          'yellow-muted': '#FAE89E',
          purple:       '#5D5FEF',
          'purple-deep':  '#4547D4',
          'purple-light': '#EDEDFD',
          dark:         '#1A1A1A',
          'dark-card':    '#2B2B2B',
          cream:        '#FDFCF0',
        },
        sidebar: {
          DEFAULT: '#1A1A1A',
          foreground: '#FFFFFF',
          accent: '#2B2B2B',
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
        card:         '3px 3px 0 rgba(93,95,239,0.12)',
        'card-lg':    '6px 6px 0 rgba(93,95,239,0.20)',
        pop:          '0 16px 48px rgba(0,0,0,0.13)',
        hard:         '4px 4px 0 rgba(93,95,239,0.18)',
        'hard-hover': '6px 6px 0 rgba(93,95,239,0.22)',
        'hard-ink':   '3px 3px 0 rgba(26,26,26,0.14)',
        focus:        '0 0 0 3px rgba(93,95,239,0.28)',
        btn:          '3px 3px 0 #1A1A1A',
        'btn-hover':  '4px 4px 0 #1A1A1A',
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
