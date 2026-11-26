import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@maris/contracts'],
  poweredByHeader: false,
};

export default config;
