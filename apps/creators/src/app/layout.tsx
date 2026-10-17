import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: { default: "Digital Sukoon Creators", template: "%s · Digital Sukoon Creators" },
  description:
    "Connect your Facebook Page or Instagram professional account to Digital Sukoon. Paid bookings are coming soon; you approve every booking before anything is posted.",
  icons: { icon: "/logo-mark.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
