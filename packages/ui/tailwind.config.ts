import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "#E8E0D0",
        background: "#FDF6E3",
        foreground: "#1A1A1A",
        muted: {
          DEFAULT: "#F7ECD5",
          foreground: "#7A7A7A",
        },
        ring: "#F5D547",
        brand: {
          yellow: "#F5D547",
          "yellow-light": "#FFF3C4",
          "yellow-muted": "#FAE89E",
          dark: "#1A1A1A",
          "dark-card": "#2B2B2B",
          cream: "#FDF6E3",
          "cream-dark": "#F0E4C4",
        },
        sidebar: {
          DEFAULT: "#1A1A1A",
          foreground: "#FFFFFF",
          accent: "#2B2B2B",
        },
      },
      borderRadius: {
        lg: "16px",
        md: "10px",
        sm: "8px",
        xl: "24px",
        pill: "999px",
      },
      boxShadow: {
        card: "0 2px 16px rgba(0,0,0,0.06)",
        "card-lg": "0 8px 32px rgba(0,0,0,0.08)",
      },
      fontFamily: {
        sans: ["'DM Sans'", "system-ui", "sans-serif"],
        serif: ["'Playfair Display'", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
