import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppJwt, GitHubAppAuth, parsePrivateKey } from './app-auth.ts';
import { fakeGitHub, json } from './fake-github.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = Date.UTC(2026, 10, 2, 20, 0, 0);

function decode(segment: string | undefined) {
  return JSON.parse(Buffer.from(segment ?? '', 'base64url').toString('utf8'));
}

describe('createAppJwt', () => {
  it('is an RS256 JWT, signed by the app key, issued by the app, valid for under ten minutes', () => {
    const [header, payload, signature] = createAppJwt('12345', privateKey, NOW).split('.');

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iat).toBeLessThan(NOW / 1000);
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('parsePrivateKey', () => {
  it('accepts a PEM whose newlines were escaped for an env file', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expect(parsePrivateKey(pem.replaceAll('\n', '\\n')).asymmetricKeyType).toBe('rsa');
  });
});

describe('GitHubAppAuth', () => {
  it('finds the installation once and reuses the token until it nears expiry', async () => {
    let now = NOW;
    let issued = 0;
    const github = fakeGitHub({
      'GET /repos/codyalves/target/installation': () => json({ id: 77 }),
      'POST /app/installations/77/access_tokens': () =>
        json({ token: `token-${++issued}`, expires_at: new Date(now + 60 * 60_000).toISOString() }, 201),
    });
    const auth = new GitHubAppAuth({ appId: '1', privateKey, fetch: github.fetch, now: () => now });

    expect(await auth.tokenFor('codyalves/target')).toBe('token-1');
    now += 30 * 60_000;
    expect(await auth.tokenFor('codyalves/target')).toBe('token-1');
    now += 26 * 60_000; // within five minutes of expiry
    expect(await auth.tokenFor('codyalves/target')).toBe('token-2');

    expect(github.requests.filter((r) => r.path.endsWith('/installation'))).toHaveLength(1);
    expect(github.requests[0]?.authorization).toMatch(/^Bearer ey/);
  });
});
