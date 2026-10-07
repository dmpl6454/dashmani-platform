// All copy for the site, from the design handoff ("Digital Sukoon - Channel Surf", renderVals()).

export const CHANNELS = [
  { slug: "network", name: "Network" },
  { slug: "reach", name: "Reach" },
  { slug: "services", name: "Services" },
  { slug: "work", name: "Work" },
  { slug: "studio", name: "Studio" },
  { slug: "contact", name: "Contact" },
] as const;

export const PROPERTY_NAMES = [
  "Movified",
  "Total Filmi",
  "Bollywood Society",
  "Bollywood Chronicle",
  "Bollywood Paparazzi",
  "Paparazzzee",
  "Crazy 4 TV",
  "Dubai Paps",
  "Telly Drama",
  "Bachelors Society",
  "Luxe Lifestyle",
  "Inde News",
  "Crazy 4 Bolly",
  "Bollywood Shots",
  "Intl. Fashion",
];

const P = "IG · FB · YT · Snap";

export const LINEUP: Record<string, [name: string, meta: string][]> = {
  Entertainment: [["Movified", "Flagship"], ["Total Filmi", P], ["Bollywood Society", P], ["Bollywood Chronicle", P]],
  Paparazzi: [["Bollywood Paparazzi", "30% celebrity share"], ["Paparazzzee", P], ["Dubai Paps", "GCC"], ["Bollywood Shots", P]],
  Television: [["Crazy 4 TV", "Multi-platform video"], ["Telly Drama", P], ["Crazy 4 Bolly", P], ["TV network", P]],
  Lifestyle: [["Bachelors Society", P], ["Intl. Fashion", P], ["Luxe Lifestyle", P], ["Inde News", P]],
  "IP & awards": [
    ["Movified Screen Awards", "Original IP"],
    ["Bollywood Chronicle Digital Award", "Original IP"],
    ["2.5M+ video footage", "Licensed library"],
    ["In-house studios", "Two studios"],
  ],
};

export const SERVICES: [title: string, body: string, formats: string[]][] = [
  ["Brand integration", "Reels, posts and stories woven into content audiences already follow.", ["Reel brand integration", "Sponsored static posts", "Exclusive stories & posts", "Verbal shoutouts"]],
  ["Audio integration", "Song promotion and audio integration on reels across the network.", ["Song promotion", "Reels audio", "Music labels", "Coke Studio"]],
  ["Content amplification", "Launch, teaser, trend and viral push across 100+ owned pages.", ["Launch & teaser", "Trend & viral push", "Social promotion at scale", "Extended reach"]],
  ["Song integration on paparazzi reels", "Your track set to exclusive celebrity paparazzi reels, published across our paparazzi network.", ["Paparazzi reels", "Celebrity spottings", "Song launches", "Music labels"]],
  ["Paparazzi & events", "On-ground spottings, event coverage, interviews and exclusives, with a 30% share of celebrity content.", ["Spottings", "Event covering", "Interviews & podcasts", "Exclusive content"]],
  ["Content marketing", "Movie and entertainment marketing for OTT, film, music and brands.", ["OTT", "Film", "Music", "Brands"]],
  ["Brand visibility", "Campaigns built on every inventory format we run.", ["Affiliate marketing", "Subscription", "Static posts", "Stories"]],
];

export const STEPS = [
  "Create or receive content",
  "Audience matching",
  "Network distribution",
  "Real-time amplification",
  "Hundreds of millions of views",
];

// CH 04 Work — brand-campaign case studies, each showing the campaign's top reel.
// To add a reel: paste its Instagram link into `reelUrl` (reel, post or tv links all work,
// e.g. "https://www.instagram.com/reel/ABC123xyz/"). Leave it "" and the card shows the
// placeholder until a link is added. `results` is optional — only add real, verified numbers.
export type CaseStudy = {
  brand: string;
  campaign: string;
  tag: string;
  reelUrl: string;
  results?: { label: string; value: string }[];
};

export const CASE_STUDIES: CaseStudy[] = [
  { brand: "Helios Luxe", campaign: "Event amplification", tag: "Event", reelUrl: "" },
  { brand: "SKF", campaign: "Entertainment", tag: "Film", reelUrl: "" },
  { brand: "Titan Eye+", campaign: "Brand integration", tag: "Brand", reelUrl: "" },
  { brand: "Coke Studio", campaign: "Music integration", tag: "Music", reelUrl: "" },
];

/**
 * Turns any Instagram post/reel link into its official embed URL, or null if the link
 * is not an Instagram post. Accepts /reel/, /reels/, /p/, /tv/ and profile-prefixed
 * links (instagram.com/<user>/reel/<code>/); drops query strings like ?igsh=.
 */
export function instagramEmbedUrl(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(reels?|p|tv)\/([A-Za-z0-9_-]+)/.exec(url.trim());
  if (!m) return null;
  const kind = m[1] === "reels" ? "reel" : m[1];
  return `https://www.instagram.com/${kind}/${m[2]}/embed/`;
}

export const LOGOS = ["Movified", "Total Filmi", "Bollywood Society", "Bollywood Chronicle", "Bollywood Paparazzi", "Paparazzzee", "Crazy 4 TV", "Dubai Paps"];

export const TEAM: [name: string, role: string][] = [
  ["Sudhanshu Kumar", "Founder"],
  ["Kapil Jain", "Co-founder & CEO"],
  ["Neekita Singh", "Co-founder"],
  ["Priyanshu Sinha", "Head, Revenue"],
  ["Abhilasha Singh", "Head, Content Partnerships & Strategy"],
  ["Shailesh Mule", "Head, Paparazzi Network"],
  ["Shrikant Tayde", "Lead, Finance"],
  ["Siddharth Singh", "Head, HR"],
  ["Sohel F Fidai", "Lead, Exclusive Content, Bollywood"],
  ["Chetna Singh", "Lead, Exclusive Content, TV"],
  ["Nishant Bhuse", "Entertainment Editor"],
  ["Aslam Shaikh", "Lead, Video Editing"],
];

export function initials(name: string): string {
  return name
    .split(" ")
    .filter((w) => w.length > 1)
    .map((w) => w[0])
    .slice(0, 2)
    .join("");
}

export const OFFICES = [
  { city: "Head office · Mumbai", address: "701/702 Parinee I, Shah Industrial Estate, Off Veera Desai Rd, Andheri West, Mumbai 400053", tel: "+918709788368", phone: "+91 87097 88368" },
  { city: "Gurgaon", address: "Unit 153 & 154, Tower B2, Spaze iTech Park, Sohna Road, Sector 49, Gurugram 122018", tel: "+916000189766", phone: "+91 60001 89766" },
  { city: "Bangalore", address: "I-1703, Brigade Metropolis, Garudacharpalya, Mahadevapura Post, Bangalore 560048", tel: "+917738257242", phone: "+91 77382 57242" },
];

export const CONTACT_EMAIL = "hello@digitalsukoon.com";
export const CONTACT_PHONE = { tel: "+918709788368", display: "+91 87097 88368" };

// Audience by platform (owner-supplied, 2026-10-07). Sums to the 400M+ headline.
export const PLATFORM_REACH = [
  { platform: "Instagram", value: "100M+" },
  { platform: "Facebook", value: "266M+" },
  { platform: "YouTube", value: "27M+" },
  { platform: "Snapchat", value: "7M+" },
];

// Network-wide monthly views (owner-supplied, 2026-10-07), shown beside the platform figures.
export const MONTHLY_VIEWS = { label: "Monthly views", value: "12–15B" };
