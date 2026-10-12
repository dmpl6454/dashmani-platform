import type { Config } from "tailwindcss";

// The creator portal shares the digitalsukoon.com design system ("Channel Surf") with the client
// portal: black canvas, white type, one indigo accent, 2px hairline dividers, square corners,
// Manrope. Same token names as apps/client/tailwind.config.ts — `ink` is the LIGHT type scale, so
// never write `bg-ink text-white` (white on white); the strongest state is `bg-indigo text-white`.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:      "#000000",
        surface: "#0d0d12",
        muted:   "#16161d",
        rule:    "rgba(255,255,255,0.10)",
        border:  "rgba(255,255,255,0.18)",
        ink: {
          DEFAULT: "#FFFFFF",
          2: "#E6E6EE",
          3: "#A7A7B0",
          4: "#5C5C66",
        },
        indigo:    { DEFAULT: "#403CFA", soft: "#1A1760", deep: "#322EEA", light: "#B8B6FF" },
        attention: { DEFAULT: "#F5B445", bg: "rgba(245,180,69,0.14)" },
        success:   { DEFAULT: "#6EE7A0", bg: "rgba(110,231,160,0.14)" },
        danger:    { DEFAULT: "#FF8A8A", bg: "rgba(255,138,138,0.14)" },
      },
      fontFamily: {
        sans: ["Manrope", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      // Square-cornered everywhere; rounded-full stays for dots and avatars.
      borderRadius: { DEFAULT: "0px", sm: "0px", md: "0px", lg: "0px", xl: "0px", "2xl": "0px", full: "999px" },
      boxShadow: { pop: "0 24px 64px rgba(0,0,0,0.7)", focus: "0 0 0 2px #403CFA" },
    },
  },
  plugins: [],
};
export default config;
