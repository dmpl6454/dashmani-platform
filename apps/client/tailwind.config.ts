import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:      '#FDFCF0',
        surface: '#FFFFFF',
        muted:   '#F3EED8',
        rule:    '#EDE7D2',
        border:  '#D4CBBA',
        ink: {
          DEFAULT: '#1A1A1A',
          2: '#3A3A3A',
          3: '#6C6555',
          4: '#9C947C',
        },
        action: {
          DEFAULT: '#F5D547',
          soft:    '#FFF3C4',
          deep:    '#E8C83A',
          ring:    'rgba(245,213,71,.32)',
        },
        neutral:   { DEFAULT: '#6C6555', bg: '#F0EAD8' },
        attention: { DEFAULT: '#C05826', bg: '#FDF0EC' },
        success:   { DEFAULT: '#4A7C52', bg: '#EDF4EE' },
        danger:    { DEFAULT: '#B83728', bg: '#FDECEA' },
        indigo:    { DEFAULT: '#5D5FEF', soft: '#EDEDFD', deep: '#4547D4' },
        sage:      { DEFAULT: '#8BA888', soft: '#EEF4ED', deep: '#5F7C5C' },
        terra:     { DEFAULT: '#E07A5F', soft: '#FDF0EC' },
        // Legacy aliases so old code doesn't break
        background: '#FDFCF0',
        foreground: '#1A1A1A',
        ring:       '#F5D547',
      },
      fontFamily: {
        sans:    ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        serif:   ['Fraunces', 'Georgia', 'serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
        instr:   ['"Instrument Serif"', 'Georgia', 'serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '12px',
        sm:  '8px',
        md:  '14px',
        lg:  '20px',
        xl:  '24px',
        '2xl': '28px',
        full: '999px',
      },
      boxShadow: {
        card:        '3px 3px 0 rgba(93,95,239,0.12)',
        pop:         '0 16px 48px rgba(0,0,0,0.13)',
        hard:        '4px 4px 0 rgba(93,95,239,0.18)',
        'hard-hover':'6px 6px 0 rgba(93,95,239,0.22)',
        'hard-ink':  '3px 3px 0 rgba(26,26,26,0.14)',
        focus:       '0 0 0 3px rgba(93,95,239,0.28)',
        btn:         '3px 3px 0 #1A1A1A',
        'btn-hover': '4px 4px 0 #1A1A1A',
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
