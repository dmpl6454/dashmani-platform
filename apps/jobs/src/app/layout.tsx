import type { Metadata, Viewport } from "next";
import Link from "next/link";
import localFont from "next/font/local";
import "./globals.css";
import { safeJsonLd } from "@/lib/jobs";
import JobAlerts from "@/components/JobAlerts";
import NavLinks from "@/components/NavLinks";
import PageBackdrop from "@/components/PageBackdrop";
import BrandMark from "@/components/BrandMark";

// Self-hosted from ./fonts (next/font/local), NOT next/font/google: the Google variant
// downloads from fonts.googleapis.com at BUILD time, and a flaky fetch there failed the
// production deploy on 2026-11-02 (and CI regularly). Each .woff2 is the latin + latin-ext
// cut Google serves, with the same axes — see fonts/README.md for how they were made.
// The weight ranges match what the Google calls requested.
const dmSans = localFont({
  src: "./fonts/dm-sans.woff2",
  variable: "--font-dm-sans",
  display: "swap",
  weight: "400 700",
});

// Loaded as the full variable font (not discrete static weights) — Bricolage
// Grotesque carries an optical-size (opsz) axis alongside weight, and it's the
// opsz axis that gives large display text its chunky, rounded, slightly quirky
// character. Pinning to static weight instances also pins opsz to a small
// default, which reads as a much plainer bold grotesque at headline sizes.
// The variable font lets the browser auto-select opsz per font-size (the CSS
// default `font-optical-sizing: auto`), which is what the source design relies on.
const bricolage = localFont({
  src: "./fonts/bricolage-grotesque.woff2",
  variable: "--font-bricolage",
  display: "swap",
  weight: "200 800",
});

const instrumentSerif = localFont({
  src: [
    { path: "./fonts/instrument-serif-regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/instrument-serif-italic.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-instrument",
  display: "swap",
  // next/font/google sized the fallback against Times New Roman for serif families.
  adjustFontFallback: "Times New Roman",
});

const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono.woff2",
  variable: "--font-jetbrains",
  display: "swap",
  weight: "400 700",
});

const SITE_URL = "https://jobs.digitalsukoon.com";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F4F4FF",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  icons: { icon: "/favicon.png", apple: "/apple-touch-icon.png" },
  title: {
    default: "Careers at Digital Sukoon — Jobs & Internships",
    template: "%s | Digital Sukoon Careers",
  },
  description:
    "Join Digital Sukoon, a full-service digital marketing agency in Mumbai. Explore open positions in social media, content creation, graphic design, video production, web development, and more. Apply for jobs or our 6-month internship program.",
  keywords: [
    "Digital Sukoon careers", "Digital Sukoon jobs", "digital marketing jobs Mumbai",
    "social media manager jobs", "content writing jobs", "graphic design internship",
    "video editor jobs", "marketing agency careers", "internship in digital marketing",
    "Digital Sukoon internship", "marketing jobs India",
  ],
  authors: [{ name: "Digital Sukoon Private Limited" }],
  creator: "Digital Sukoon Private Limited",
  publisher: "Digital Sukoon Private Limited",
  robots: {
    index: true, follow: true,
    googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
  },
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website", locale: "en_IN", url: SITE_URL,
    siteName: "Digital Sukoon Careers",
    title: "Careers at Digital Sukoon — Jobs & Internships",
    description: "Join our team. Explore open positions in marketing, content creation, design, video production, and more.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Careers at Digital Sukoon — Jobs & Internships",
    description: "Explore open positions and internship opportunities at Digital Sukoon.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Digital Sukoon",
    legalName: "Digital Sukoon Private Limited",
    url: "https://digitalsukoon.com",
    logo: "https://digitalsukoon.com/logo.png",
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
    publisher: { "@type": "Organization", name: "Digital Sukoon Private Limited" },
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
        {/* Records the URL this document was actually loaded at, before React hydrates.
            Runs exactly once per document (never on client-side navigation), so the hero
            preloader can tell "someone opened/refreshed the homepage" apart from "someone
            navigated back to the homepage from a role page" — the latter must not replay
            it. A module-scoped variable can't answer this: if the visitor lands on a role
            page first, the homepage's module isn't evaluated until the back-navigation,
            by which point location.pathname already reads "/". */}
        <script dangerouslySetInnerHTML={{ __html: "window.__dsEntryPath=location.pathname" }} />
      </head>
      <body>
        {/* Fixed decorative layers behind every page (bubbles + gradient wash). */}
        <PageBackdrop />
        <div className="ds-page">
          {/* NAV */}
          <nav className="ds-nav">
            {/* next/link, not <a> — a raw anchor full-loads the document and re-arms
                the hero preloader flags (see NavLinks.tsx for the full explanation). */}
            <Link className="ds-brand" href="/" aria-label="Digital Sukoon Careers">
              <BrandMark />
              <span className="wordmark">
                <span className="name">Digital Sukoon</span>
              </span>
            </Link>
            <div className="ds-nav-right">
              <JobAlerts />
              <NavLinks />
            </div>
          </nav>

          {/* PAGE CONTENT */}
          <main>{children}</main>

          {/* FOOTER — two rows, left/right aligned, per the source design. */}
          <footer className="ds-colophon">
            <div className="ds-colophon-row">
              <p className="tag">Crafting digital experiences that matter.</p>
            </div>
            <div className="ds-colophon-row fine">
              <span className="contact">
                <img src="/illustrations/contact-us.svg" alt="" aria-hidden="true" width={22} height={11} />
                <Link href="/privacy">Privacy</Link> · Help · <a href="mailto:careers@digitalsukoon.com">careers@digitalsukoon.com</a>
              </span>
              <span>© {new Date().getFullYear()} Digital Sukoon</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
