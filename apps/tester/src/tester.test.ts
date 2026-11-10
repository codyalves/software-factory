import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingFingerprint } from '@factory/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmRepro } from './confirm.ts';
import { crawl } from './crawl.ts';
import { reproFor } from './repro.ts';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const PLAYWRIGHT = join(APP_DIR, 'node_modules', '.bin', 'playwright');

/** A small site with one planted problem of each kind; `fixed` removes them. */
function fixtureSite(state: { fixed: boolean }): Server {
  const html = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
  return createServer((req, res) => {
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (req.url) {
      case '/':
        return send(
          200,
          'text/html',
          html(
            'Home',
            [
              '<h1>Juniper Ridge</h1>',
              '<a href="/about">About</a> <a href="/missing">Pricing</a>',
              state.fixed ? '<img src="/logo.png" alt="Juniper Ridge logo">' : '<img src="/logo.png">',
              state.fixed ? '' : "<script>console.error('menu failed to load')</script>",
            ].join(''),
          ),
        );
      case '/about':
        return send(
          200,
          'text/html',
          html(
            'About',
            [
              '<h1>About</h1><a href="/">Home</a>',
              state.fixed ? '' : '<script>window.renderHours()</script>',
              `<script>fetch('/api/hours')</script>`,
            ].join(''),
          ),
        );
      case '/api/hours':
        return state.fixed ? send(200, 'application/json', '[]') : send(500, 'text/plain', 'boom');
      case '/logo.png':
        return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      case '/missing':
        return state.fixed
          ? send(200, 'text/html', html('Pricing', '<h1>Pricing</h1>'))
          : send(404, 'text/html', html('Not found', '<h1>Not found</h1>'));
      default:
        return send(404, 'text/plain', 'not found');
    }
  });
}

describe('tester', () => {
  const state = { fixed: false };
  let server: Server;
  let baseUrl: string;
  let workdir: string;

  beforeAll(async () => {
    server = fixtureSite(state);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Inside the app folder, so the generated tests resolve @playwright/test and axe.
    workdir = await mkdtemp(join(APP_DIR, '.fixture-'));
    await writeFile(
      join(workdir, 'playwright.config.ts'),
      'export default { use: { baseURL: process.env.BASE_URL } };\n',
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(workdir, { recursive: true, force: true });
  });

  it('finds one problem of each kind, and nothing it cannot prove', async () => {
    state.fixed = false;
    const { pages, observations } = await crawl(baseUrl);

    expect([...pages].sort()).toEqual(['/', '/about']);
    expect(observations.map((o) => `${o.finding.category} ${o.finding.page}`).sort()).toEqual([
      'accessibility /',
      'broken_link /missing',
      'console_error /',
      'http_error /about',
      'page_error /about',
    ]);
    const byCategory = Object.fromEntries(observations.map((o) => [o.finding.category, o.finding]));
    expect(byCategory.page_error?.summary).toContain('TypeError');
    expect(byCategory.http_error?.evidence).toBe('500 GET /api/hours');
    expect(byCategory.accessibility?.summary).toMatch(/^image-alt:/);
    expect(byCategory.broken_link?.evidence).toContain('Linked from:\n/');
  }, 60_000);

  it('confirms every finding with a test that fails three times out of three, and passes once fixed', async () => {
    state.fixed = false;
    const { observations } = await crawl(baseUrl);

    for (const o of observations) {
      const repro = reproFor(o.finding, o.repro);
      expect(repro.content).toContain("test('AC-1: ".replace("'", '"'));

      state.fixed = false;
      expect(await confirmRepro(repro, { workdir, baseUrl, playwrightBin: PLAYWRIGHT }), repro.path).toEqual({
        runs: 3,
        failures: 3,
        confirmed: true,
        reason: null,
      });

      state.fixed = true;
      expect(
        await confirmRepro(repro, { workdir, baseUrl, playwrightBin: PLAYWRIGHT }),
        repro.path,
      ).toMatchObject({
        failures: 0,
        confirmed: false,
        reason: 'the test passes: not reproducible',
      });
    }
  }, 300_000);

  it('names repro files by category, page and fingerprint', async () => {
    state.fixed = false;
    const { observations } = await crawl(baseUrl);
    const pageError = observations.find((o) => o.finding.category === 'page_error');
    if (!pageError) throw new Error('expected a page error');

    expect(reproFor(pageError.finding, pageError.repro).path).toBe(
      `tests/regressions/page-error-about-${findingFingerprint(pageError.finding).slice(0, 8)}.spec.ts`,
    );
  }, 60_000);
});
