import { Instagram, Youtube, Linkedin, Twitter, Facebook, Globe } from "lucide-react";

function SnapchatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.002 2C8.756 2 6.6 4.09 6.6 7.2v.617c-.43.19-.9.127-1.37.064C4.8 7.818 4.37 7.8 4 7.98c-.55.26-.58.94-.12 1.24.1.063.82.44 1.32 1.56.04.094.062.18.062.25 0 .063-.02.13-.055.2-.256.47-.9.73-1.44.87-.63.162-.9.51-.82.88.094.44.596.7 1.22.7.11 0 .23-.01.35-.03.28-.043.55-.07.78-.07.18 0 .34.018.48.055-.04.44-.065.89-.065 1.34 0 2.547 2.14 4.518 5.29 4.518.22 0 .44-.01.65-.03.142.23.396.36.67.36h.336c.275 0 .53-.13.67-.36.213.02.432.03.652.03 3.15 0 5.29-1.97 5.29-4.518 0-.45-.026-.9-.065-1.34.14-.037.3-.055.48-.055.228 0 .5.027.777.07.12.02.24.03.353.03.622 0 1.125-.26 1.218-.7.08-.37-.19-.718-.82-.88-.54-.14-1.183-.4-1.44-.87a.42.42 0 0 1-.055-.2c0-.07.023-.156.063-.25.497-1.12 1.22-1.497 1.32-1.56.457-.3.43-.98-.12-1.24-.37-.18-.8-.162-1.23-.1-.467.064-.937.127-1.37-.063V7.2C17.4 4.09 15.245 2 12.002 2Z"/>
    </svg>
  );
}

const MAP: Record<string, React.ElementType> = {
  instagram: Instagram,
  youtube: Youtube,
  linkedin: Linkedin,
  twitter: Twitter,
  facebook: Facebook,
  x: Twitter,
  snapchat: SnapchatIcon,
};

interface PlatformIconProps {
  slug?: string | null;
  className?: string;
}

export function PlatformIcon({ slug, className = "h-4 w-4" }: PlatformIconProps) {
  const Icon = MAP[(slug || "").toLowerCase()] ?? Globe;
  return <Icon className={className} />;
}
