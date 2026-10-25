/** @type {import('next').NextConfig} */
// Creator portal (creators.digitalsukoon.com). Exported as static files to `out/`, which nginx
// serves directly — no Node process, no pm2 entry, so no `start` script. Every page is a client
// page that talks to the API at NEXT_PUBLIC_API_URL (baked at build time, like the other portals).
// Static export means no dynamic route segments: detail views take `?id=` instead.
module.exports = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
};
