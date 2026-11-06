import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTargets } from './gates.ts';

describe('gates/targets.json', () => {
  it('is valid and protects each target’s CI and gate configuration', async () => {
    const targets = await loadTargets(fileURLToPath(new URL('../../../gates/targets.json', import.meta.url)));

    expect(Object.keys(targets).length).toBeGreaterThan(0);
    for (const target of Object.values(targets)) {
      expect(target.protectedPaths).toEqual(expect.arrayContaining(['.github/**', 'package.json']));
      expect(Object.keys(target.gates).length).toBeGreaterThan(0);
    }
  });
});
