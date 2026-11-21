/**
 * The free, instant half of checking a request before it is filed: words a
 * test cannot pin down. Triage asks the real question ("could an engineer
 * build and check each expectation with tests?"); this catches the common
 * misses before anyone pays for that, and says what to write instead.
 */
export interface VagueCriterion {
  readonly criterion: string;
  readonly why: string;
}

const VAGUE: readonly { readonly pattern: RegExp; readonly why: (word: string) => string }[] = [
  {
    pattern:
      /\b(improved?|better|nicer|nice|modern|newest|latest|cleaner|clean|sleek|polished|beautiful|great|good|intuitive|user[- ]friendly|seamless|enhanced|upgraded?|optimi[sz]ed|appropriate|properly)\b/i,
    why: (word) =>
      `"${word}" is a judgment, and a test cannot check a judgment. Say what a visitor sees or can do, and where.`,
  },
  {
    pattern: /\b(exists?|is present|is there|works)\b/i,
    why: (word) =>
      `"${word}" does not say what to check. Name what is shown, where, and what happens when it is used.`,
  },
  {
    pattern: /\b(fast|faster|quick|quickly|responsive)\b/i,
    why: (word) => `"${word}" needs a number or a size, such as "within 2 seconds" or "at 375 pixels wide".`,
  },
];

/** Criteria too vague to test, each with why. An empty list means nothing obvious was found. */
export function vagueCriteria(criteria: readonly string[]): VagueCriterion[] {
  const found: VagueCriterion[] = [];
  for (const criterion of criteria) {
    if (criterion.split(/\s+/).filter(Boolean).length < 4) {
      found.push({ criterion, why: 'Too short to test. Say what is shown or what happens, and where.' });
      continue;
    }
    for (const { pattern, why } of VAGUE) {
      const word = pattern.exec(criterion)?.[1];
      // A number or a quoted text usually makes it checkable ("loads within 2 seconds").
      if (word && !/\d|"[^"]+"/.test(criterion)) {
        found.push({ criterion, why: why(word) });
        break;
      }
    }
  }
  return found;
}
