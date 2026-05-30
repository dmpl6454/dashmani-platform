const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function extractYouTubeVideoId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");

  // youtu.be/<videoId>
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return isValidVideoId(id) ? id : null;
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const path = url.pathname;

  // /watch?v=<videoId>
  const vParam = url.searchParams.get("v");
  if (vParam && isValidVideoId(vParam)) return vParam;

  // /shorts/<videoId>, /embed/<videoId>, /live/<videoId>
  const segments = path.split("/").filter(Boolean);
  const prefixes = ["shorts", "embed", "live", "e"];
  for (let i = 0; i < segments.length - 1; i++) {
    if (prefixes.includes(segments[i])) {
      const id = segments[i + 1];
      if (isValidVideoId(id)) return id;
    }
  }

  return null;
}

function isValidVideoId(id: string): boolean {
  // YouTube video IDs are exactly 11 characters: [A-Za-z0-9_-]
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}