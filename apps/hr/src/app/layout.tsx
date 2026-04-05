import type { Metadata } from "next";
import { HrAuthProvider } from "@/components/auth-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Digital Sukoon - Employee Portal",
  description: "HR Employee Portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HrAuthProvider>
          {children}
        </HrAuthProvider>
      </body>
    </html>
  );
}
