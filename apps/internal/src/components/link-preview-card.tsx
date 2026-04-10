"use client";
import { useState, useEffect } from "react";
import { Heart, MessageCircle, Share2, Eye, ExternalLink, Image as ImageIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  twitter: "bg-sky-100 text-sky-700 border-sky-200",
  linkedin: "bg-blue-50 text-blue-700 border-blue-200",
  facebook: "bg-blue-50 text-blue-600 border-blue-200",
  youtube: "bg-red-50 text-red-700 border-red-200",
  tiktok: "bg-gray-100 text-gray-800 border-gray-200",
};

const PLATFORM_ICONS: Record<string, string> = {
  instagram: "https://www.instagram.com/favicon.ico",
  twitter: "https://abs.twimg.com/favicons/twitter.3.ico",
  linkedin: "https://www.linkedin.com/favicon.ico",
  facebook: "https://www.facebook.com/favicon.ico",
  youtube: "https://www.youtube.com/favicon.ico",
  tiktok: "https://www.tiktok.com/favicon.ico",
};

// In-memory cache to avoid re-fetching same URLs
const previewCache = new Map<string, { image: string | null; title: string | null }>();

function getStaticThumbnail(url: string, platform: string): string | null {
  if (platform === "youtube") {
    const match = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (match?.[1]) return `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
  }
  return null;
}

function getInstagramEmbedUrl(url: string): string | null {
  const match = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (match) return `https://www.instagram.com/${match[1]}/${match[2]}/embed/`;
  return null;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

interface LinkData {
  id?: string;
  url: string;
  platform?: string;
  accountName?: string;
  account?: { name: string };
  description?: string;
  mediaUrl?: string;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  views?: number | null;
}

/* ── Instagram Grid Card ── */
function InstagramGridCard({ link }: { link: LinkData }) {
  const igEmbedUrl = getInstagramEmbedUrl(link.url);
  const accountName = link.accountName ?? link.account?.name ?? "";
  const hasEngagement = link.likes != null || link.comments != null || link.shares != null || link.views != null;

  return (
    <div className="rounded-xl border border-[#E8E0D0] bg-white overflow-hidden hover:border-pink-300 hover:shadow-[0_4px_20px_rgba(0,0,0,0.08)] transition-all w-[306px] inline-block align-top">
      {/* 3:4 embed area — Instagram grid style */}
      <a href={link.url} target="_blank" rel="noopener noreferrer" className="block relative group">
        <div className="relative w-[306px] h-[408px] overflow-hidden bg-black">
          {igEmbedUrl ? (
            <iframe
              src={igEmbedUrl}
              className="border-0 absolute top-0 left-0"
              style={{ width: 306, height: 600, pointerEvents: "none" }}
              loading="lazy"
              allowTransparency
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 flex items-center justify-center">
              <img src={PLATFORM_ICONS.instagram} alt="" className="h-12 w-12 opacity-70" />
            </div>
          )}

          {/* Hover overlay — Instagram style */}
          {hasEngagement && (
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-6">
              {link.likes != null && (
                <div className="flex items-center gap-1.5 text-white">
                  <Heart className="h-5 w-5 fill-white" />
                  <span className="font-semibold text-sm">{formatNumber(link.likes)}</span>
                </div>
              )}
              {link.comments != null && (
                <div className="flex items-center gap-1.5 text-white">
                  <MessageCircle className="h-5 w-5 fill-white" />
                  <span className="font-semibold text-sm">{formatNumber(link.comments)}</span>
                </div>
              )}
              {link.shares != null && (
                <div className="flex items-center gap-1.5 text-white">
                  <Share2 className="h-5 w-5" />
                  <span className="font-semibold text-sm">{formatNumber(link.shares)}</span>
                </div>
              )}
            </div>
          )}

          {/* Instagram icon badge */}
          <div className="absolute top-2.5 right-2.5 h-7 w-7 rounded-lg bg-white/90 shadow flex items-center justify-center">
            <img src={PLATFORM_ICONS.instagram} alt="" className="h-4 w-4" />
          </div>
        </div>
      </a>

      {/* Bottom info bar */}
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-6 w-6 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 flex items-center justify-center shrink-0">
              <span className="text-white text-[10px] font-bold">{accountName?.[0]?.toUpperCase() || "I"}</span>
            </div>
            <span className="text-sm font-medium text-[#1A1A1A] truncate">{accountName || "Instagram"}</span>
          </div>
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 h-7 w-7 rounded-lg bg-[#FEFCF7] border border-[#E8E0D0] flex items-center justify-center text-[#7A7A7A] hover:text-pink-600 hover:border-pink-200 transition-all"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        {link.description && (
          <p className="text-xs text-[#555] line-clamp-1 mt-1">{link.description}</p>
        )}
        {/* Engagement row below */}
        {hasEngagement && (
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[#F0EAD8]">
            {link.likes != null && (
              <div className="flex items-center gap-1 text-xs">
                <Heart className="h-3 w-3 text-red-400" />
                <span className="font-medium">{formatNumber(link.likes)}</span>
              </div>
            )}
            {link.comments != null && (
              <div className="flex items-center gap-1 text-xs">
                <MessageCircle className="h-3 w-3 text-blue-400" />
                <span className="font-medium">{formatNumber(link.comments)}</span>
              </div>
            )}
            {link.shares != null && (
              <div className="flex items-center gap-1 text-xs">
                <Share2 className="h-3 w-3 text-green-500" />
                <span className="font-medium">{formatNumber(link.shares)}</span>
              </div>
            )}
            {link.views != null && (
              <div className="flex items-center gap-1 text-xs">
                <Eye className="h-3 w-3 text-[#7A7A7A]" />
                <span className="font-medium">{formatNumber(link.views)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Generic Link Card (non-Instagram) ── */
export function LinkPreviewCard({ link }: { link: LinkData }) {
  const platform = (link.platform ?? "").toLowerCase();

  // Instagram gets its own grid-style card
  if (platform === "instagram") return <InstagramGridCard link={link} />;

  const badgeClass = PLATFORM_COLORS[platform] ?? "bg-[#FFF3C4] text-[#1A1A1A] border-[#E8E0D0]";
  const faviconUrl = PLATFORM_ICONS[platform];
  const staticThumb = link.mediaUrl || getStaticThumbnail(link.url, platform);
  const hasEngagement = link.likes != null || link.comments != null || link.shares != null || link.views != null;
  const totalEngagement = (link.likes || 0) + (link.comments || 0) + (link.shares || 0);

  const [ogData, setOgData] = useState<{ image: string | null; title: string | null } | null>(
    previewCache.get(link.url) || null
  );
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (staticThumb || previewCache.has(link.url)) return;

    let cancelled = false;
    apiFetch<any>(`/admin/link-preview?url=${encodeURIComponent(link.url)}`)
      .then((res) => {
        if (cancelled) return;
        const data = { image: res.data?.image || null, title: res.data?.title || null };
        previewCache.set(link.url, data);
        setOgData(data);
      })
      .catch(() => {
        previewCache.set(link.url, { image: null, title: null });
      });

    return () => { cancelled = true; };
  }, [link.url, staticThumb]);

  const thumbnail = staticThumb || ogData?.image;
  const ogTitle = ogData?.title;

  return (
    <div className="rounded-xl border border-[#E8E0D0] bg-white overflow-hidden hover:border-[#F5D547] hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition-all group">
      <div className="flex">
        {/* Thumbnail */}
        {thumbnail && !imgError ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 w-[120px] h-[100px] bg-gray-50 overflow-hidden relative"
          >
            <img
              src={thumbnail}
              alt=""
              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
              onError={() => setImgError(true)}
            />
            {faviconUrl && (
              <div className="absolute bottom-1.5 left-1.5 h-5 w-5 rounded bg-white/90 shadow-sm flex items-center justify-center">
                <img src={faviconUrl} alt="" className="h-3 w-3" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            )}
          </a>
        ) : (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 w-[60px] flex items-center justify-center bg-gray-50 border-r border-[#F0EAD8]"
          >
            {faviconUrl ? (
              <img src={faviconUrl} alt="" className="h-6 w-6 opacity-60" onError={(e) => { (e.target as HTMLImageElement).replaceWith(Object.assign(document.createElement("div"), { className: "h-6 w-6" })); }} />
            ) : (
              <ImageIcon className="h-5 w-5 text-[#D0D0D0]" />
            )}
          </a>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${badgeClass}`}>
                  {link.platform ?? "—"}
                </span>
                <span className="text-sm font-medium text-[#1A1A1A] truncate">
                  {link.accountName ?? link.account?.name ?? "—"}
                </span>
              </div>
              {(ogTitle || link.description) && (
                <p className="text-xs text-[#555] line-clamp-2 mb-1">{link.description || ogTitle}</p>
              )}
              <p className="text-[10px] text-[#B0B0B0] truncate">{link.url}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 h-8 w-8 rounded-lg bg-[#FEFCF7] border border-[#E8E0D0] flex items-center justify-center text-[#7A7A7A] hover:text-[#1A1A1A] hover:border-[#F5D547] transition-all"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          {hasEngagement && (
            <div className="flex items-center gap-4 mt-2 pt-2 border-t border-[#F0EAD8]">
              {link.likes != null && (
                <div className="flex items-center gap-1 text-xs">
                  <Heart className="h-3 w-3 text-red-400" />
                  <span className="font-medium text-[#1A1A1A]">{formatNumber(link.likes)}</span>
                </div>
              )}
              {link.comments != null && (
                <div className="flex items-center gap-1 text-xs">
                  <MessageCircle className="h-3 w-3 text-blue-400" />
                  <span className="font-medium text-[#1A1A1A]">{formatNumber(link.comments)}</span>
                </div>
              )}
              {link.shares != null && (
                <div className="flex items-center gap-1 text-xs">
                  <Share2 className="h-3 w-3 text-green-500" />
                  <span className="font-medium text-[#1A1A1A]">{formatNumber(link.shares)}</span>
                </div>
              )}
              {link.views != null && (
                <div className="flex items-center gap-1 text-xs">
                  <Eye className="h-3 w-3 text-[#7A7A7A]" />
                  <span className="font-medium text-[#1A1A1A]">{formatNumber(link.views)}</span>
                </div>
              )}
              {totalEngagement > 0 && (
                <span className="ml-auto text-[10px] text-[#B0B0B0]">
                  {formatNumber(totalEngagement)} total
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
