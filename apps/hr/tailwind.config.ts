import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg:      "#FDFCF0",
        surface: "#FFFFFF",
        muted:   { DEFAULT: "#F3EED8", foreground: "#6C6555" },
        rule:    "#EDE7D2",
        border:  "#D4CBBA",
        ink: {
          DEFAULT: "#1A1A1A",
          2: "#3A3A3A",
          3: "#6C6555",
          4: "#9C947C",
        },
        action:  { DEFAULT: "#F5D547", soft: "#FFF3C4", deep: "#E8C83A", ring: "rgba(245,213,71,.32)" },
        attention: { DEFAULT: "#C05826", bg: "#FDF0EC" },
        success:   { DEFAULT: "#4A7C52", bg: "#EDF4EE" },
        danger:    { DEFAULT: "#B83728", bg: "#FDECEA" },
        indigo:    { DEFAULT: "#5D5FEF", soft: "#EDEDFD", deep: "#4547D4" },
        sage:      { DEFAULT: "#8BA888", soft: "#EEF4ED" },
        terra:     { DEFAULT: "#E07A5F", soft: "#FDF0EC" },
        // Legacy aliases so any remaining old classes don't crash
        brand: {
          yellow: "#F5D547",
          "yellow-light": "#FFF3C4",
          "yellow-muted": "#FAE89E",
          purple: "#5D5FEF",
          "purple-deep": "#4547D4",
          "purple-light": "#EDEDFD",
          dark: "#1A1A1A",
          "dark-card": "#2B2B2B",
          cream: "#FDFCF0",
          "cream-dark": "#F3EED8",
        },
        sidebar: { DEFAULT: "#FFFFFF", foreground: "#1A1A1A", accent: "#F3EED8" },
        background: "#FDFCF0",
        foreground: "#1A1A1A",
        ring: "#5D5FEF",
      },
      borderRadius: {
        DEFAULT: "12px",
        sm: "8px",
        md: "14px",
        lg: "20px",
        xl: "24px",
        "2xl": "28px",
        full: "999px",
        pill: "999px",
      },
      boxShadow: {
        card:         "3px 3px 0 rgba(93,95,239,0.12)",
        pop:          "0 16px 48px rgba(0,0,0,0.13)",
        hard:         "4px 4px 0 rgba(93,95,239,0.18)",
        "hard-hover": "6px 6px 0 rgba(93,95,239,0.22)",
        focus:        "0 0 0 3px rgba(93,95,239,0.28)",
        btn:          "3px 3px 0 #1A1A1A",
        "btn-hover":  "4px 4px 0 #1A1A1A",
        "card-lg":    "0 8px 32px rgba(0,0,0,0.08)",
      },
      fontFamily: {
        sans:    ['"Plus Jakarta Sans"', "system-ui", "sans-serif"],
        serif:   ["Fraunces", "Georgia", "serif"],
        display: ["Fraunces", "Georgia", "serif"],
      },
      spacing: {
        rail:  "220px",
        railc: "58px",
      },
    },
  },
  plugins: [],
};
export default config;
