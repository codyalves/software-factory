import { type Finding, findingFingerprint, REGRESSION_DIR, type ReproTest } from '@factory/domain';
import type { ReproSpec } from './crawl.ts';

/**
 * A Playwright test that fails while the finding is real and passes once it
 * is fixed. Generated from a template, not written by a model, so the check
 * is exactly the observation. Its name starts with AC-1 because the issue's
 * only acceptance criterion is that this test passes.
 *
 * Paths are relative: the target's Playwright config sets baseURL.
 */
export function reproFor(finding: Finding, spec: ReproSpec): ReproTest {
  const slug = `${finding.category}-${pathSlug(spec.kind === 'broken_link' ? spec.target : spec.page)}-${findingFingerprint(finding).slice(0, 8)}`;
  const path = `${REGRESSION_DIR}/${slug.replace(/_/g, '-')}.spec.ts`;
  return { path, content: render(spec) };
}

const q = (value: string) => JSON.stringify(value);

function render(spec: ReproSpec): string {
  const header = [
    '// Regression test written by the software factory tester. Protected:',
    '// a fix must make it pass as written.',
  ];
  switch (spec.kind) {
    case 'page_error':
      return lines(header, "import { expect, test } from '@playwright/test';", '', [
        `test(${q(`AC-1: ${spec.page} loads without uncaught errors`)}, async ({ page }) => {`,
        '  const errors: string[] = [];',
        "  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`));",
        `  await page.goto(${q(spec.page)}, { waitUntil: 'networkidle' });`,
        '  expect(errors).toEqual([]);',
        '});',
      ]);
    case 'console_error':
      return lines(header, "import { expect, test } from '@playwright/test';", '', [
        `test(${q(`AC-1: ${spec.page} logs no console errors`)}, async ({ page }) => {`,
        '  const errors: string[] = [];',
        "  page.on('console', (message) => {",
        "    // Failed requests are their own finding; this test is about the page's own errors.",
        "    if (message.type() === 'error' && !/^Failed to load resource:/.test(message.text())) errors.push(message.text());",
        '  });',
        `  await page.goto(${q(spec.page)}, { waitUntil: 'networkidle' });`,
        '  expect(errors).toEqual([]);',
        '});',
      ]);
    case 'http_error':
      return lines(header, "import { expect, test } from '@playwright/test';", '', [
        `test(${q(`AC-1: ${spec.page} loads without failed requests`)}, async ({ page, baseURL }) => {`,
        "  const origin = new URL(baseURL ?? 'http://localhost').origin;",
        '  const failed: string[] = [];',
        "  page.on('response', (response) => {",
        '    const url = new URL(response.url());',
        "    if (response.status() >= 400 && url.origin === origin && response.request().resourceType() !== 'document') {",
        '      failed.push(`${response.status()} ${response.request().method()} ${url.pathname}`);',
        '    }',
        '  });',
        `  await page.goto(${q(spec.page)}, { waitUntil: 'networkidle' });`,
        '  expect(failed).toEqual([]);',
        '});',
      ]);
    case 'broken_link':
      return lines(header, "import { expect, test } from '@playwright/test';", '', [
        `test(${q(`AC-1: links to ${spec.target} lead to a page`)}, async ({ request }) => {`,
        `  const response = await request.get(${q(spec.target)}, { maxRedirects: 5 });`,
        '  expect(response.status()).toBeLessThan(400);',
        '});',
      ]);
    case 'accessibility':
      return lines(
        header,
        "import AxeBuilder from '@axe-core/playwright';\nimport { expect, test } from '@playwright/test';",
        '',
        [
          `test(${q(`AC-1: ${spec.page} passes the ${spec.rule} accessibility check`)}, async ({ page }) => {`,
          `  await page.goto(${q(spec.page)}, { waitUntil: 'networkidle' });`,
          `  const results = await new AxeBuilder({ page }).withRules([${q(spec.rule)}]).analyze();`,
          '  expect(results.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);',
          '});',
        ],
      );
  }
}

function lines(header: string[], imports: string, blank: string, body: string[]): string {
  return [...header, imports, blank, ...body, ''].join('\n');
}

function pathSlug(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'home').slice(0, 40);
}
