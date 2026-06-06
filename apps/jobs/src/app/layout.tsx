import type { Metadata, Viewport } from "next";
import {
  DM_Sans,
  Bricolage_Grotesque,
  Instrument_Serif,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import { safeJsonLd } from "@/lib/jobs";

// Self-hosted via next/font — no render-blocking external stylesheet.
const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-instrument",
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
  weight: ["400", "500"],
});

const SITE_URL = "https://jobs.digitalsukoon.com";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F4F4FF",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Careers at Digital Sukoon | Dashmani Media — Jobs & Internships",
    template: "%s | Digital Sukoon Careers",
  },
  description:
    "Join Digital Sukoon, a full-service digital marketing agency by Dashmani Media. Explore open positions in social media, content creation, graphic design, video production, web development, and more. Apply for jobs or our 6-month internship program.",
  keywords: [
    "Digital Sukoon careers", "Dashmani Media jobs", "digital marketing jobs Mumbai",
    "social media manager jobs", "content writing jobs", "graphic design internship",
    "video editor jobs", "marketing agency careers", "internship in digital marketing",
    "Digital Sukoon internship", "Dashmani Media internship", "marketing jobs India",
  ],
  authors: [{ name: "Dashmani Media Private Limited" }],
  creator: "Dashmani Media Private Limited",
  publisher: "Dashmani Media Private Limited",
  robots: {
    index: true, follow: true,
    googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
  },
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website", locale: "en_IN", url: SITE_URL,
    siteName: "Digital Sukoon Careers",
    title: "Careers at Digital Sukoon | Dashmani Media",
    description: "Join our team. Explore open positions in marketing, content creation, design, video production, and more.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Careers at Digital Sukoon | Dashmani Media",
    description: "Explore open positions and internship opportunities at Digital Sukoon.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Digital Sukoon",
    legalName: "Dashmani Media Private Limited",
    url: "https://digitalsukoon.com",
    logo: "https://digitalsukoon.com/logo.svg",
    sameAs: [
      "https://www.instagram.com/digitalsukoon",
      "https://www.linkedin.com/company/digitalsukoon",
    ],
    address: {
      "@type": "PostalAddress",
      addressLocality: "Mumbai",
      addressCountry: "IN",
    },
  };

  const siteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Digital Sukoon Careers",
    url: SITE_URL,
    description: "Career opportunities at Digital Sukoon — a full-service digital marketing agency.",
    publisher: { "@type": "Organization", name: "Dashmani Media Private Limited" },
  };

  const fontVars = [dmSans.variable, bricolage.variable, instrumentSerif.variable, jetbrainsMono.variable].join(" ");

  return (
    <html lang="en" className={fontVars}>
      <head>
        {/* NOTE: no hardcoded <link rel="canonical"> here — a layout-level canonical
            applies to EVERY page and was overriding each job detail page's own
            canonical, telling Google every role was a duplicate of the homepage.
            Per-page canonicals come from `alternates.canonical` in each page's
            metadata / generateMetadata (homepage default canonical is in metadata). */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: safeJsonLd([orgSchema, siteSchema]) }}
        />
      </head>
      <body>
        <div className="ds-page">
          {/* NAV */}
          <nav className="ds-nav">
            <a className="ds-brand" href="/" aria-label="Digital Sukoon Careers">
              <img className="mark" src="/logo.svg" alt="Digital Sukoon" width={32} height={32} />
              <span className="wordmark">
                <span className="name">Digital Sukoon</span>
              </span>
            </a>
            <div className="ds-nav-right">
              <a className="ds-nav-link" href="/#index">Jobs</a>
              <a className="ds-nav-cta" href="/internship">
                <span className="pulse" />
                Internship
              </a>
            </div>
          </nav>

          {/* PAGE CONTENT */}
          <main>{children}</main>

          {/* FOOTER */}
          <footer className="ds-colophon">
            <p className="tag">Crafting digital experiences that matter.</p>
            <nav className="footer-links" aria-label="Footer navigation">
              <a href="/">All Jobs</a>
              <span className="sep" />
              <a href="/internship">Internship</a>
              <span className="sep" />
              <a href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer">
                digitalsukoon.com
              </a>
            </nav>
            <p className="copyright">© {new Date().getFullYear()} Dashmani Media Private Limited</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
