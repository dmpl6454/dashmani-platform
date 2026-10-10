import type { Config } from "tailwindcss";

// The client portal shares the digitalsukoon.com design system ("Channel Surf",
// apps/web/src/app/globals.css): black canvas, white type, one indigo accent,
// 2px hairline dividers, square corners, Manrope. The token NAMES are the ones
// the portal was built on (ink, surface, muted, indigo…) so every page restyles
// through this file; only the VALUES changed. `ink` is now the light type scale.
const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:      '#000000',
        surface: '#0d0d12',
        muted:   '#16161d',
        rule:    'rgba(255,255,255,0.10)',
        border:  'rgba(255,255,255,0.18)',
        ink: {
          DEFAULT: '#FFFFFF',
          2: '#E6E6EE',
          3: '#A7A7B0',
          4: '#5C5C66',
        },
        // "action" used to be the yellow highlight; the site has one accent.
        action: {
          DEFAULT: '#403CFA',
          soft:    '#1A1760',
          deep:    '#322EEA',
          ring:    'rgba(64,60,250,.32)',
        },
        neutral:   { DEFAULT: '#A7A7B0', bg: '#16161D' },
        attention: { DEFAULT: '#F5B445', bg: 'rgba(245,180,69,0.14)' },
        success:   { DEFAULT: '#6EE7A0', bg: 'rgba(110,231,160,0.14)' },
        danger:    { DEFAULT: '#FF8A8A', bg: 'rgba(255,138,138,0.14)' },
        indigo:    { DEFAULT: '#403CFA', soft: '#1A1760', deep: '#322EEA', light: '#B8B6FF' },
        sage:      { DEFAULT: '#6EE7A0', soft: 'rgba(110,231,160,0.14)', deep: '#6EE7A0' },
        terra:     { DEFAULT: '#FF8A8A', soft: 'rgba(255,138,138,0.14)' },
        // Legacy aliases so old code doesn't break
        background: '#000000',
        foreground: '#FFFFFF',
        ring:       '#403CFA',
      },
      fontFamily: {
        sans:    ['Manrope', 'system-ui', 'sans-serif'],
        serif:   ['Manrope', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
        instr:   ['Manrope', 'system-ui', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      // The site is square-cornered. Every rounded-* utility collapses to 0 so
      // the pages did not need touching; rounded-full stays for dots/avatars.
      borderRadius: {
        DEFAULT: '0px',
        sm:  '0px',
        md:  '0px',
        lg:  '0px',
        xl:  '0px',
        '2xl': '0px',
        full: '999px',
      },
      // No drop or offset shadows on the site; depth comes from borders.
      boxShadow: {
        card:        'none',
        pop:         '0 24px 64px rgba(0,0,0,0.7)',
        hard:        'none',
        'hard-hover':'none',
        'hard-ink':  'none',
        focus:       '0 0 0 2px #403CFA',
        btn:         'none',
        'btn-hover': 'none',
      },
      spacing: {
        rail:  '230px',
        railc: '58px',
        row:   '48px',
        rowc:  '44px',
      },
    },
  },
  plugins: [],
};
export default config;
