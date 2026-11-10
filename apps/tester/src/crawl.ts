import AxeBuilder from '@axe-core/playwright';
import type { Finding } from '@factory/domain';
import { type Browser, chromium, type Page } from 'playwright';

/**
 * How to reproduce a finding with a test. The crawler records it alongside
 * the finding; repro.ts turns it into a Playwright test file.
 */
export type ReproSpec =
  | { readonly kind: 'page_error'; readonly page: string }
  | { readonly kind: 'console_error'; readonly page: string }
  | { readonly kind: 'http_error'; readonly page: string }
  | { readonly kind: 'broken_link'; readonly target: string }
  | { readonly kind: 'accessibility'; readonly page: string; readonly rule: string };

export interface Observation {
  readonly finding: Finding;
  readonly repro: ReproSpec;
}

export interface CrawlResult {
  readonly pages: readonly string[];
  readonly observations: readonly Observation[];
}

/** WCAG 2.1 A and AA: the checks axe can decide without a person. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Visits every same-origin page reachable from the start page (breadth first,
 * up to maxPages) and records problems a program can decide on its own:
 * uncaught errors, console errors, failed same-origin requests, links that
 * lead nowhere, and serious or critical accessibility violations.
 */
export async function crawl(
  baseUrl: string,
  options: { maxPages?: number; browser?: Browser } = {},
): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 30;
  const origin = new URL(baseUrl).origin;
  const browser = options.browser ?? (await chromium.launch());
  const context = await browser.newContext({ baseURL: origin });
  const observations: Observation[] = [];
  const queue: string[] = [new URL(baseUrl).pathname || '/'];
  const visited = new Set<string>();
  /** Pages that loaded and were checked; visited also holds ones that did not load. */
  const inspected: string[] = [];
  /** link target -> pages that link to it */
  const links = new Map<string, Set<string>>();

  try {
    while (queue.length > 0 && inspected.length < maxPages) {
      const path = queue.shift() as string;
      if (visited.has(path)) continue;
      visited.add(path);

      const page = await context.newPage();
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
      page.on('console', (message) => {
        // Chrome also logs every failed request; those are reported as http_error.
        if (message.type() === 'error' && !isResourceFailure(message.text()))
          consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        // The page's own status is the broken-link check's business.
        if (
          response.status() >= 400 &&
          url.origin === origin &&
          response.request().resourceType() !== 'document'
        ) {
          failedRequests.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
        }
      });

      const response = await page.goto(path, { waitUntil: 'networkidle' }).catch(() => null);
      if (!response || response.status() >= 400) {
        // Not a page we can inspect; links to it are reported as broken.
        await page.close();
        continue;
      }
      inspected.push(path);

      for (const href of await sameOriginLinks(page, origin)) {
        if (!links.has(href)) links.set(href, new Set());
        links.get(href)?.add(path);
        if (!visited.has(href) && !queue.includes(href)) queue.push(href);
      }

      if (pageErrors.length > 0) {
        observations.push({
          finding: {
            category: 'page_error',
            page: path,
            summary: firstLine(pageErrors[0] as string),
            signature: [...new Set(pageErrors)].sort().join('\n'),
            severity: 'high',
            evidence: pageErrors.join('\n\n'),
          },
          repro: { kind: 'page_error', page: path },
        });
      }
      if (consoleErrors.length > 0) {
        observations.push({
          finding: {
            category: 'console_error',
            page: path,
            summary: firstLine(consoleErrors[0] as string),
            signature: [...new Set(consoleErrors)].sort().join('\n'),
            severity: 'medium',
            evidence: consoleErrors.join('\n'),
          },
          repro: { kind: 'console_error', page: path },
        });
      }
      if (failedRequests.length > 0) {
        const serverError = failedRequests.some((r) => r.startsWith('5'));
        observations.push({
          finding: {
            category: 'http_error',
            page: path,
            summary: `${failedRequests.length === 1 ? failedRequests[0] : `${failedRequests.length} requests failed`}`,
            signature: [...new Set(failedRequests)].sort().join('\n'),
            severity: serverError ? 'high' : 'medium',
            evidence: failedRequests.join('\n'),
          },
          repro: { kind: 'http_error', page: path },
        });
      }

      const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      for (const violation of axe.violations) {
        if (violation.impact !== 'serious' && violation.impact !== 'critical') continue;
        observations.push({
          finding: {
            category: 'accessibility',
            page: path,
            summary: `${violation.id}: ${violation.help}`,
            signature: violation.id,
            severity: violation.impact === 'critical' ? 'high' : 'medium',
            evidence: [
              `${violation.help} (${violation.impact})`,
              violation.helpUrl,
              '',
              ...violation.nodes
                .slice(0, 10)
                .map((n) => `${n.target.join(' ')}\n  ${n.failureSummary ?? ''}`),
            ].join('\n'),
          },
          repro: { kind: 'accessibility', page: path, rule: violation.id },
        });
      }
      await page.close();
    }

    // Every link target, including ones beyond maxPages, must resolve.
    for (const [target, from] of links) {
      const status = await context.request
        .get(target, { maxRedirects: 5, failOnStatusCode: false })
        .then((r) => r.status())
        .catch(() => 0);
      if (status === 0 || status >= 400) {
        observations.push({
          finding: {
            category: 'broken_link',
            page: target,
            summary: `links to ${target} lead to ${status === 0 ? 'no response' : `HTTP ${status}`}`,
            signature: target,
            severity: 'medium',
            evidence: [
              `GET ${target} -> ${status === 0 ? 'no response' : status}`,
              '',
              'Linked from:',
              ...[...from].sort(),
            ].join('\n'),
          },
          repro: { kind: 'broken_link', target },
        });
      }
    }
  } finally {
    await context.close();
    if (!options.browser) await browser.close();
  }

  return { pages: inspected, observations };
}

async function sameOriginLinks(page: Page, origin: string): Promise<string[]> {
  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((a) => (a as unknown as { href: string }).href),
  );
  const paths = new Set<string>();
  for (const href of hrefs) {
    try {
      const url = new URL(href);
      if (url.origin === origin && (url.protocol === 'http:' || url.protocol === 'https:')) {
        paths.add(url.pathname);
      }
    } catch {}
  }
  return [...paths].sort();
}

/** Chrome's console line for a failed request. Kept in sync with the console repro template. */
export const RESOURCE_FAILURE = /^Failed to load resource:/;

function isResourceFailure(text: string): boolean {
  return RESOURCE_FAILURE.test(text);
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? text).slice(0, 100);
}
