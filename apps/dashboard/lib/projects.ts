/**
 * The factory builds more than one site. The owner picks which one the
 * workspace shows and files work into; the choice lives in a cookie, and is
 * checked against the configured list on every request.
 */
export const PROJECT_COOKIE = 'factory.project';

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** "a/b, c/d" from the environment, as a list of valid owner/repo names, without repeats. */
export function projectList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => REPO.test(s)),
    ),
  ];
}

/** The requested project if it is configured, else the first (default) one. */
export function pickProject(projects: readonly string[], requested: string | undefined): string {
  return requested && projects.includes(requested) ? requested : (projects[0] ?? '');
}

/** "codyalves/brewery" → "brewery", for tight places like the switcher. */
export function projectName(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1);
}
