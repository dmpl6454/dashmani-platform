import { MetadataRoute } from "next";

const SITE_URL = "https://jobs.digitalsukoon.com";
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: new Date(), changeFrequency: "daily", priority: 1.0 },
    { url: `${SITE_URL}/internship`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
  ];

  try {
    const res = await fetch(`${API_URL}/jobs`, { next: { revalidate: 3600 } });
    const data = await res.json();
    const jobs = data?.data || [];

    const jobPages: MetadataRoute.Sitemap = jobs.map((job: any) => ({
      url: `${SITE_URL}/${job.id}`,
      lastModified: new Date(job.updatedAt || job.createdAt),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));

    return [...staticPages, ...jobPages];
  } catch {
    return staticPages;
  }
}
