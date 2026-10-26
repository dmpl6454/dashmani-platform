/** @type {import('next').NextConfig} */
// Static export served by nginx from apps/sales/out (same shape as apps/creators and apps/web):
// no server process on the 2 GB box; every page is a client-rendered shell that talks to the API.
module.exports = {
  output: "export",
  images: { unoptimized: true },
  transpilePackages: ["@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
};
