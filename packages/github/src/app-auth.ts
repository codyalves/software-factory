import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { type Fetch, githubRequest } from './client.ts';

const base64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/**
 * The short-lived JWT a GitHub App signs with its private key to prove its
 * identity. Backdated a minute for clock drift; valid for nine minutes (the
 * limit is ten).
 */
export function createAppJwt(appId: string, privateKey: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Accepts a PEM with real newlines, or with `\n` escapes as env files often store it. */
export function parsePrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem);
}

export interface GitHubAppAuthOptions {
  readonly appId: string;
  readonly privateKey: KeyObject;
  readonly fetch?: Fetch;
  readonly baseUrl?: string;
  readonly now?: () => number;
}

/** Refresh installation tokens this long before they expire (they last an hour). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Installation access tokens for a GitHub App: scoped to the repositories the
 * App is installed on and to the permissions it was granted, valid for an
 * hour, cached until shortly before expiry.
 */
export class GitHubAppAuth {
  readonly #options: Required<Omit<GitHubAppAuthOptions, 'appId' | 'privateKey'>> & GitHubAppAuthOptions;
  readonly #installations = new Map<string, number>();
  readonly #tokens = new Map<number, { token: string; expiresAt: number }>();
  #botLogin: Promise<string> | undefined;

  constructor(options: GitHubAppAuthOptions) {
    this.#options = {
      fetch: globalThis.fetch,
      baseUrl: 'https://api.github.com',
      now: Date.now,
      ...options,
    };
  }

  /**
   * The login the App acts as, e.g. "cody-software-factory[bot]". Issues by
   * this author are the factory's own; their embedded regression tests are trusted.
   */
  async botLogin(): Promise<string> {
    this.#botLogin ??= githubRequest<{ slug: string }>(this.#appRequest(), 'GET', '/app').then(
      ({ slug }) => `${slug}[bot]`,
    );
    return this.#botLogin;
  }

  /** A token that can act on `repo` (owner/name). */
  async tokenFor(repo: string): Promise<string> {
    const installationId = await this.#installationFor(repo);
    const cached = this.#tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.#options.now()) {
      return cached.token;
    }

    const { token, expires_at } = await githubRequest<{ token: string; expires_at: string }>(
      this.#appRequest(),
      'POST',
      `/app/installations/${installationId}/access_tokens`,
    );
    this.#tokens.set(installationId, { token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  async #installationFor(repo: string): Promise<number> {
    const known = this.#installations.get(repo);
    if (known !== undefined) {
      return known;
    }
    const { id } = await githubRequest<{ id: number }>(
      this.#appRequest(),
      'GET',
      `/repos/${repo}/installation`,
    );
    this.#installations.set(repo, id);
    return id;
  }

  #appRequest() {
    return {
      fetch: this.#options.fetch,
      baseUrl: this.#options.baseUrl,
      now: this.#options.now,
      token: createAppJwt(this.#options.appId, this.#options.privateKey, this.#options.now()),
    };
  }
}
