import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalJson } from './canonical-json.ts';

describe('canonical JSON', () => {
  it('produces the same text regardless of key order', () => {
    const a = canonicalize('{ "b": 1, "a": { "y": [3, {"d": 4, "c": 5}], "x": null } }');
    const b = canonicalize('{"a":{"x":null,"y":[3,{"c":5,"d":4}]},"b":1}');

    expect(a).toBe('{"a":{"x":null,"y":[3,{"c":5,"d":4}]},"b":1}');
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(canonicalize('[3, 1, 2]')).toBe('[3,1,2]');
  });

  it('drops undefined properties, as JSON does', () => {
    expect(canonicalJson({ zeta: 1, alpha: 'x', gone: undefined })).toBe('{"alpha":"x","zeta":1}');
  });
});
