import type { Metadata } from "next";

const SITE_URL = "https://jobs.digitalsukoon.com";

export const metadata: Metadata = {
  title: "6-Month Internship Program — Digital Sukoon | Apply Now",
  description: "Apply for Digital Sukoon's 6-month internship in digital marketing, content creation, graphic design, video production, web development & more. Gain hands-on experience, earn a certificate, and get a performance-based stipend. Open to students and freshers.",
  keywords: [
    "Digital Sukoon internship", "marketing internship Mumbai", "digital marketing internship",
    "content writing internship", "graphic design internship", "social media internship",
    "6 month internship", "paid internship marketing", "internship with certificate",
    "Dashmani Media internship", "internship for freshers", "video production internship",
  ],
  alternates: { canonical: `${SITE_URL}/internship` },
  openGraph: {
    type: "website",
    url: `${SITE_URL}/internship`,
    title: "6-Month Internship Program — Digital Sukoon",
    description: "Gain hands-on experience in digital marketing, content creation, design & more. Certificate + stipend included. Apply now.",
    siteName: "Digital Sukoon Careers",
  },
  twitter: {
    card: "summary_large_image",
    title: "6-Month Internship at Digital Sukoon — Apply Now",
    description: "Hands-on internship in digital marketing, design, content creation & more. Certificate + stipend included.",
  },
};

export default function InternshipLayout({ children }: { children: React.ReactNode }) {
  const internshipSchema = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "6-Month Internship — Digital Marketing & Creative",
    description: "Join Digital Sukoon as an intern and gain hands-on experience in digital marketing, content creation, graphic design, video production, and social media management. Receive a completion certificate, letter of recommendation, and performance-based stipend.",
    datePosted: "2026-04-01",
    validThrough: "2026-12-31",
    employmentType: "INTERN",
    hiringOrganization: {
      "@type": "Organization",
      name: "Digital Sukoon",
      sameAs: "https://digitalsukoon.com",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Mumbai",
        addressRegion: "Maharashtra",
        addressCountry: "IN",
      },
    },
    applicantLocationRequirements: {
      "@type": "Country",
      name: "India",
    },
    jobLocationType: "TELECOMMUTE",
    directApply: true,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(internshipSchema) }}
      />
      {children}
    </>
  );
}
