import type { NextConfig } from 'next';

const config: NextConfig = {
  // The factory's packages are TypeScript sources with .ts import paths.
  transpilePackages: ['@factory/db', '@factory/domain'],
  serverExternalPackages: ['pg'],
  // `pnpm typecheck` checks this app with its own tsconfig.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default config;
