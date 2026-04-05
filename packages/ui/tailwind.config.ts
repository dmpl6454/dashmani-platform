import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        ring: "hsl(var(--ring))",
        brand: {
          blue: "#0A45BB",
          "blue-dark": "#083490",
          "blue-light": "#1A5FE0",
          orange: "#FE5E00",
          "orange-dark": "#D94E00",
          "orange-light": "#FF7A2E",
        },
        sidebar: {
          DEFAULT: "#0A45BB",
          foreground: "#FFFFFF",
          accent: "#1A5FE0",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
