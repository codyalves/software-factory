import { describe, expect, it } from 'vitest';
import { parseAddedLines, redact } from './workspace.ts';

describe('redact', () => {
  it('removes credentials from git URLs in messages', () => {
    expect(redact('fatal: could not read https://x-access-token:ghs_secret@github.com/o/r.git')).toBe(
      'fatal: could not read https://***@github.com/o/r.git',
    );
  });
});

describe('parseAddedLines', () => {
  it('reports added lines with their new line numbers, per file', () => {
    const diff = [
      'diff --git a/year.js b/year.js',
      '--- a/year.js',
      '+++ b/year.js',
      '@@ -1 +1 @@',
      '-export const footerYear = () => 2025;',
      '+export const footerYear = () => new Date().getFullYear();',
      'diff --git a/new.js b/new.js',
      '--- /dev/null',
      '+++ b/new.js',
      '@@ -0,0 +4,2 @@',
      '+one',
      '+two',
      'diff --git a/gone.js b/gone.js',
      '--- a/gone.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');

    expect(parseAddedLines(diff)).toEqual([
      {
        path: 'year.js',
        addedLines: [{ line: 1, text: 'export const footerYear = () => new Date().getFullYear();' }],
      },
      {
        path: 'new.js',
        addedLines: [
          { line: 4, text: 'one' },
          { line: 5, text: 'two' },
        ],
      },
    ]);
  });
});
