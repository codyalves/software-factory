import { describe, expect, it } from 'vitest';
import { networkEnv } from './env.ts';

describe('networkEnv', () => {
  it('keeps proxy and CA settings and drops everything else', () => {
    expect(
      networkEnv({
        HTTPS_PROXY: 'http://proxy:3128',
        NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        GITHUB_TOKEN: 'ghs_secret',
        DATABASE_URL: 'postgres://u:p@h/db',
      }),
    ).toEqual({ HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' });
  });
});
