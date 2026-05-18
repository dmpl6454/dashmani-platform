/** @type {import('next').NextConfig} */
module.exports = {
  transpilePackages: ["@dashmani/ui", "@dashmani/shared"],
  eslint: { ignoreDuringBuilds: true },
};
