import type { NextConfig } from 'next';

const config: NextConfig = {
  // The factory's packages are TypeScript sources with .ts import paths.
  transpilePackages: ['@factory/db', '@factory/decisions', '@factory/domain', '@factory/github'],
  // The request check asks triage's question with triage's own prompt file.
  outputFileTracingIncludes: { '/*': ['../../prompts/*.md'] },
  serverExternalPackages: ['pg'],
  // `pnpm typecheck` checks this app with its own tsconfig.
  typescript: { ignoreBuildErrors: true },
  poweredByHeader: false,
};

export default config;
