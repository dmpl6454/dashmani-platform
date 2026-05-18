/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@dashmani/ui", "@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
};
module.exports = nextConfig;
