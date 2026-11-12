import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { WebVitalsReporter } from "@/components/web-vitals";

export const metadata: Metadata = {
  title: { default: "Digital Sukoon Billing", template: "%s · Digital Sukoon Billing" },
  description: "GST invoices, payments, bank statements, accounts, reconciliation and Tally for Digital Sukoon and Dashmani Media.",
  icons: { icon: "/favicon.png", apple: "/apple-touch-icon.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* The body font, fetched alongside the CSS instead of after it (self-hosted, public/fonts). */}
        <link rel="preload" href="/fonts/manrope-normal-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        <WebVitalsReporter />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
