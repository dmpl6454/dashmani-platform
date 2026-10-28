// Security headers (security audit 2026-10-28). No CSP yet: these apps load Google
// Identity Services and inline theme scripts, and a CSP needs its own rollout.
// geolocation stays allowed for this origin: the HR report submit records location.
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), payment=(), usb=(), geolocation=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ["@dashmani/ui", "@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
