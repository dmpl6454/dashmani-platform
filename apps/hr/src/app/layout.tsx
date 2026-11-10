import type { Metadata, Viewport } from "next";
import { HrAuthProvider } from "@/components/auth-provider";
import "./globals.css";
import { WebVitalsReporter } from "@/components/web-vitals";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Digital Sukoon - Employee Portal",
  description: "HR Employee Portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head />
      <body className="font-sans antialiased">
        <WebVitalsReporter />
        <HrAuthProvider>
          {children}
        </HrAuthProvider>
      </body>
    </html>
  );
}
