/** @type {import('next').NextConfig} */
// Public marketing site (digitalsukoon.com). Exported as static files to `out/`, which
// nginx serves directly (nginx/digitalsukoon.com) — no Node process, no pm2 entry.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
};
module.exports = nextConfig;
