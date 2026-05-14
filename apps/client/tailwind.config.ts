import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#FDF6E3",
        surface: "#FFFFFF",
        muted: "#F7ECD5",
        rule: "#F0EAD8",
        border: "#E8E0D0",
        background: "#FDF6E3",
        foreground: "#1A1A1A",
        ring: "#F5D547",

        ink: {
          DEFAULT: "#1A1A1A",
          2: "#3A3A3A",
          3: "#6C6555",
          4: "#9C947C",
        },

        // The ONE accent. Brand yellow == action. Never status.
        action: {
          DEFAULT: "#F5D547",
          soft: "#FFF3C4",
          deep: "#E8C83A",
          ring: "rgba(245,213,71,.32)",
        },

        // The 4 status tokens — every previous state remaps into one of these.
        neutral: { DEFAULT: "#6C6555", bg: "#F0EAD8" },
        attention: { DEFAULT: "#B0571C", bg: "#FBE6D6" },
        success: { DEFAULT: "#3F6E2A", bg: "#E5EFD9" },
        danger: { DEFAULT: "#A8331F", bg: "#F4D4CF" },
      },
      fontFamily: {
        sans: ["'Instagram Sans'", "system-ui", "sans-serif"],
        serif: ["'Instagram Sans'", "system-ui", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "8px",
        sm: "6px",
        md: "10px",
        lg: "12px",
        xl: "14px",
        full: "999px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(0,0,0,0.03), 0 2px 8px rgba(0,0,0,0.04)",
        pop: "0 8px 28px rgba(0,0,0,0.12)",
        focus: "0 0 0 3px rgba(245,213,71,0.32)",
      },
      spacing: {
        rail: "168px",
        railc: "56px",
        row: "44px",
        rowc: "40px",
      },
    },
  },
  plugins: [],
};
export default config;
