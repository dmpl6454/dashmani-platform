import { Instagram, Youtube, Linkedin, Twitter, Facebook, Globe } from "lucide-react";

const MAP: Record<string, React.ElementType> = {
  instagram: Instagram,
  youtube: Youtube,
  linkedin: Linkedin,
  twitter: Twitter,
  facebook: Facebook,
  x: Twitter,
};

interface PlatformIconProps {
  slug?: string | null;
  className?: string;
}

export function PlatformIcon({ slug, className = "h-4 w-4" }: PlatformIconProps) {
  const Icon = MAP[(slug || "").toLowerCase()] ?? Globe;
  return <Icon className={className} />;
}
