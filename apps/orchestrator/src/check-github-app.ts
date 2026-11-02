/**
 * Checks the factory's GitHub App setup for one repository without changing
 * anything: signs an app JWT, finds the installation, and gets a token.
 *
 *   GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY_FILE=./key.pem \
 *     node apps/orchestrator/src/check-github-app.ts codyalves/software-factory
 */
import { readFileSync } from 'node:fs';
import { GitHubAppAuth, githubRequest, parsePrivateKey } from '@factory/github';

const repo = process.argv[2];
const appId = process.env.GITHUB_APP_ID;
const pem =
  process.env.GITHUB_APP_PRIVATE_KEY ||
  (process.env.GITHUB_APP_PRIVATE_KEY_FILE
    ? readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8')
    : '');

if (!repo || !appId || !pem) {
  console.error(
    'usage: GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY_FILE=key.pem node apps/orchestrator/src/check-github-app.ts owner/repo',
  );
  process.exit(2);
}

try {
  const token = await new GitHubAppAuth({ appId, privateKey: parsePrivateKey(pem) }).tokenFor(repo);
  const { permissions } = await githubRequest<{ permissions?: Record<string, boolean> }>(
    { fetch, baseUrl: 'https://api.github.com', token },
    'GET',
    `/repos/${repo}`,
  );
  console.log(`OK: the app is installed on ${repo} and can act on it.`);
  console.log(`Token permissions on the repo: ${JSON.stringify(permissions ?? {})}`);
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Check the App ID, the private key, and that the app is installed on this repository.');
  process.exit(1);
}
