/**
 * Environment variables passed to the processes the factory starts (gate
 * commands, the coding agent). Only network plumbing a corporate proxy
 * needs: no keys, no tokens. Everything else is dropped.
 */
const NETWORK = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
] as const;

export function networkEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of NETWORK) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}
