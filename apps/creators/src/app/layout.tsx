import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: { default: "Digital Sukoon Creators", template: "%s · Digital Sukoon Creators" },
  description:
    "Connect your Facebook Page or Instagram professional account to Digital Sukoon. Brands book promotion on your page; you approve every booking before anything is posted.",
  icons: { icon: "/favicon.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The body font, fetched alongside the CSS instead of after it (self-hosted, public/fonts). */}
        <link rel="preload" href="/fonts/manrope-normal-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
