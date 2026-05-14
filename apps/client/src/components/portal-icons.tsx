import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  sw?: number;
  className?: string;
}

interface IProps extends IconProps {
  path: ReactNode;
  fill?: string;
}

const I = ({ path, fill, size = 20, sw = 1.5, className = "" }: IProps) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    className={className}
    fill={fill || "none"}
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

export const Icon = {
  Dashboard: (p: IconProps) => <I {...p} path={<><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></>} />,
  Folder: (p: IconProps) => <I {...p} path={<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>} />,
  Edit: (p: IconProps) => <I {...p} path={<><path d="M14.5 4.5 19 9l-9.5 9.5H5v-4.5Z"/><path d="m12.5 6.5 4.5 4.5"/></>} />,
  Check: (p: IconProps) => <I {...p} path={<path d="m5 12.5 4.5 4.5L19 7.5"/>} />,
  CheckBadge: (p: IconProps) => <I {...p} path={<><path d="M12 2.5 14 4l2.5-.4.7 2.4 2.3.8-.4 2.4L21 11l-1.6 1.8.4 2.4-2.3.8-.7 2.4L14 17.5 12 19l-2-1.5-2.5.4-.7-2.4-2.3-.8.4-2.4L3 11l1.6-1.8L4.2 6.8l2.3-.8.7-2.4L9.5 4Z"/><path d="m9 11.5 2.2 2.2L15 9.7"/></>} />,
  Chart: (p: IconProps) => <I {...p} path={<><path d="M4 19h17"/><path d="M7 16V9"/><path d="M11 16V5"/><path d="M15 16v-4"/><path d="M19 16v-8"/></>} />,
  File: (p: IconProps) => <I {...p} path={<><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13 3v6h6"/></>} />,
  Search: (p: IconProps) => <I {...p} path={<><circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.5-3.5"/></>} />,
  Bell: (p: IconProps) => <I {...p} path={<><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 6 1.5 6h-15S6 13 6 9Z"/><path d="M10 19a2 2 0 0 0 4 0"/></>} />,
  Plus: (p: IconProps) => <I {...p} path={<><path d="M12 5v14"/><path d="M5 12h14"/></>} />,
  ChevDown: (p: IconProps) => <I {...p} path={<path d="m6 9 6 6 6-6"/>} />,
  ChevUp: (p: IconProps) => <I {...p} path={<path d="m18 15-6-6-6 6"/>} />,
  ChevLeft: (p: IconProps) => <I {...p} path={<path d="m15 6-6 6 6 6"/>} />,
  ChevRight: (p: IconProps) => <I {...p} path={<path d="m9 6 6 6-6 6"/>} />,
  Close: (p: IconProps) => <I {...p} path={<><path d="M6 6 18 18"/><path d="M18 6 6 18"/></>} />,
  Dot: (p: IconProps) => <I {...p} path={<circle cx="12" cy="12" r="4" fill="currentColor"/>} />,
  X: (p: IconProps) => <I {...p} path={<><path d="M6 6 18 18"/><path d="M18 6 6 18"/></>} />,
  Play: (p: IconProps) => <I {...p} path={<path d="M7.5 5.5 17.5 12 7.5 18.5Z" fill="currentColor"/>} />,
  Clock: (p: IconProps) => <I {...p} path={<><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l2.5 2"/></>} />,
  Calendar: (p: IconProps) => <I {...p} path={<><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M9 3v4"/><path d="M15 3v4"/></>} />,
  Reel: (p: IconProps) => <I {...p} path={<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></>} />,
  Carousel: (p: IconProps) => <I {...p} path={<><rect x="6" y="6" width="13" height="13" rx="2"/><path d="M3 9v7a2 2 0 0 0 2 2h7"/></>} />,
  Story: (p: IconProps) => <I {...p} path={<><rect x="6" y="3" width="12" height="18" rx="6"/><circle cx="12" cy="12" r="2"/></>} />,
  Image: (p: IconProps) => <I {...p} path={<><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 16 4-4 5 5"/><path d="m13 14 3-3 4 4"/></>} />,
  Comment: (p: IconProps) => <I {...p} path={<path d="M5 6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5l-4 3v-3H7a2 2 0 0 1-2-2Z"/>} />,
  Send: (p: IconProps) => <I {...p} path={<><path d="M21 4 3 11l7 2 2 7Z"/><path d="m10 13 4-4"/></>} />,
  Logout: (p: IconProps) => <I {...p} path={<><path d="M9 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></>} />,
  Sparkle: (p: IconProps) => <I {...p} path={<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>} />,
  ArrowRight: (p: IconProps) => <I {...p} path={<><path d="M5 12h14"/><path d="m13 5 7 7-7 7"/></>} />,
  More: (p: IconProps) => <I {...p} path={<><circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/></>} />,
  Heart: (p: IconProps) => <I {...p} path={<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 5.5-7 10-7 10Z"/>} />,
  Bookmark: (p: IconProps) => <I {...p} path={<path d="M6 4h12v16l-6-4-6 4Z"/>} />,
  Share: (p: IconProps) => <I {...p} path={<><path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="m22 2-11 11"/></>} />,
};
