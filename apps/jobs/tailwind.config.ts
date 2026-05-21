import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "#E8E0D0",
        background: "#F4F4FF",
        foreground: "#0B0F3A",
        muted: {
          DEFAULT: "#E9EAFF",
          foreground: "rgba(11,15,58,0.55)",
        },
        ring: "#2027E6",
        brand: {
          paper: "#F4F4FF",
          "paper-deep": "#E9EAFF",
          ink: "#0B0F3A",
          "ink-soft": "#2A2F66",
          accent: "#2027E6",
          "accent-deep": "#131AB8",
          "accent-light": "#4F58FF",
          "accent-tint": "#DEE0FF",
        },
      },
      borderRadius: {
        lg: "16px",
        md: "10px",
        sm: "8px",
        xl: "22px",
        pill: "999px",
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        bricolage: ['"Bricolage Grotesque"', "sans-serif"],
        serif: ['"Instrument Serif"', '"Times New Roman"', "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
