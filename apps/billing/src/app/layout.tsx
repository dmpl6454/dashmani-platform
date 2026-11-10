import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";
import { WebVitalsReporter } from "@/components/web-vitals";

export const metadata: Metadata = {
  title: { default: "Digital Sukoon Billing", template: "%s · Digital Sukoon Billing" },
  description: "GST invoices, payments, bank statements, accounts, reconciliation and Tally for Digital Sukoon and Dashmani Media.",
  icons: { icon: "/logo-mark.svg" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#000000" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WebVitalsReporter />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
