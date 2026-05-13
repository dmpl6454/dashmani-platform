import type { Metadata, Viewport } from "next";
import "./globals.css";

const SITE_URL = "https://jobs.digitalsukoon.com";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#FEFCF7",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Careers at Digital Sukoon | Dashmani Media — Jobs & Internships",
    template: "%s | Digital Sukoon Careers",
  },
  description: "Join Digital Sukoon, a full-service digital marketing agency by Dashmani Media. Explore open positions in social media, content creation, graphic design, video production, web development, and more. Apply for jobs or our 6-month internship program.",
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
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
  },
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: SITE_URL,
    siteName: "Digital Sukoon Careers",
    title: "Careers at Digital Sukoon | Dashmani Media",
    description: "Join our team. Explore open positions in marketing, content creation, design, video production, and more. Apply for jobs or our 6-month internship program.",
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

  return (
    <html lang="en">
      <head>
        <link rel="canonical" href={SITE_URL} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify([orgSchema, siteSchema]) }}
        />
      </head>
      <body className="bg-[#FEFCF7] text-[#1A1A1A] antialiased" style={{ fontFamily: "'Instagram Sans', system-ui, sans-serif", fontWeight: 300 }}>
        {/* Header */}
        <header className="sticky top-0 z-50 border-b border-[#F0EAD8]/80 bg-[rgba(253,246,227,0.92)] backdrop-blur-xl">
          <div className="max-w-5xl mx-auto flex items-center justify-between px-6 py-4">
            <a href="/" className="flex items-center gap-3 group" aria-label="Digital Sukoon Careers - Home">
              <img src="/logo.svg" alt="Digital Sukoon" className="h-10 w-10 rounded-full group-hover:shadow-[0_2px_12px_rgba(91,75,245,0.25)] transition-shadow" />
              <div>
                <p className="text-sm font-bold tracking-widest uppercase" style={{ letterSpacing: "2px", fontSize: "13px" }}>Digital Sukoon</p>
                <p className="text-[10px] text-[#7A7A7A] tracking-wider uppercase">Careers</p>
              </div>
            </a>
            <nav aria-label="Main navigation" className="flex items-center gap-5">
              <a href="/" className="text-sm font-medium text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors relative after:absolute after:bottom-[-4px] after:left-0 after:w-0 after:h-[2px] after:bg-[#5B4BF5] hover:after:w-full after:transition-all after:duration-300">Jobs</a>
              <a href="/internship" className="text-sm font-medium text-white bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] px-4 py-2 rounded-full hover:shadow-[0_4px_16px_rgba(91,75,245,0.35)] transition-all">Internship</a>
            </nav>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-6 py-10">
          {children}
        </main>

        {/* Footer */}
        <footer className="border-t border-[#E8E0D0]/60 bg-gradient-to-b from-white/40 to-[#FEFCF7]">
          <div className="max-w-5xl mx-auto px-6 py-10">
            <div className="flex flex-col items-center gap-6">
              <p className="text-sm text-[#B0B0B0] font-medium tracking-wide">Crafting digital experiences that matter.</p>
              <nav aria-label="Footer navigation" className="flex items-center gap-6 text-sm text-[#7A7A7A]">
                <a href="/" className="hover:text-[#1A1A1A] transition-colors">All Jobs</a>
                <span className="w-1 h-1 rounded-full bg-[#5B4BF5]/30" />
                <a href="/internship" className="hover:text-[#5B4BF5] transition-colors">Internship</a>
                <span className="w-1 h-1 rounded-full bg-[#5B4BF5]/30" />
                <a href="https://digitalsukoon.com" target="_blank" rel="noopener noreferrer" className="hover:text-[#1A1A1A] transition-colors">digitalsukoon.com</a>
              </nav>
              <p className="text-xs text-[#B0B0B0]">&copy; {new Date().getFullYear()} Dashmani Media Private Limited</p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
