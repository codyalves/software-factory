import targets from '../../../gates/targets.json';

/**
 * Where a target lives once merged, read from gates/targets.json: the same
 * file the factory's own production check reads, so the status page and the
 * factory cannot disagree about which site or which deploy signal is meant.
 */
export interface TargetSite {
  readonly baseBranch: string;
  readonly production: {
    readonly url: string;
    readonly statusContext: string;
    readonly environment: string;
  } | null;
}

interface TargetEntry {
  readonly baseBranch?: string;
  readonly production?: {
    readonly url: string;
    readonly environment?: string;
    readonly statusContext?: string;
  };
}

/** Every repository the factory is set up to build: the keys of gates/targets.json, in its order. */
export function targetRepos(): string[] {
  return Object.keys(targets);
}

/** Defaults match the schema in apps/workers/src/gates.ts. An unlisted repo gets them all. */
export function targetSite(repo: string): TargetSite {
  const entry = (targets as Readonly<Record<string, TargetEntry>>)[repo];
  return {
    baseBranch: entry?.baseBranch ?? 'main',
    production: entry?.production
      ? {
          url: entry.production.url,
          environment: entry.production.environment ?? 'Production',
          statusContext: entry.production.statusContext ?? 'Vercel',
        }
      : null,
  };
}
