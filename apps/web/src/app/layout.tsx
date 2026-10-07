import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font — no render-blocking external stylesheet.
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap", weight: "variable" });

const SITE_URL = "https://digitalsukoon.com";
const DESCRIPTION =
  "Digital Sukoon is a media network and amplification company connecting brands, entertainment and culture with 400M+ audiences across Facebook, Instagram, YouTube and Snapchat.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Digital Sukoon · We distribute attention",
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Digital Sukoon",
    title: "Digital Sukoon · We distribute attention",
    description: DESCRIPTION,
    images: [{ url: "/logo.png", width: 512, height: 512, alt: "Digital Sukoon" }],
  },
  twitter: { card: "summary", title: "Digital Sukoon · We distribute attention", description: DESCRIPTION, images: ["/logo.png"] },
};

export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1, viewportFit: "cover" };

const orgJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Digital Sukoon",
  legalName: "Dashmani Media Private Limited",
  url: SITE_URL,
  logo: `${SITE_URL}/logo.png`,
  email: "hello@digitalsukoon.com",
  telephone: "+91 87097 88368",
  address: {
    "@type": "PostalAddress",
    streetAddress: "701/702 Parinee I, Shah Industrial Estate, Off Veera Desai Rd, Andheri West",
    addressLocality: "Mumbai",
    postalCode: "400053",
    addressCountry: "IN",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd).replace(/</g, "\\u003c") }} />
        {children}
      </body>
    </html>
  );
}
