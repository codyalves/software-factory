import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangedFile, TestFile } from '@factory/domain';
import { isTestFile } from '@factory/domain';
import { networkEnv } from './env.ts';

/** How a worker reaches a target repository. */
export interface RepoAccess {
  /** A clone/push URL. For GitHub it carries a short-lived installation token. */
  remoteUrl(repo: string): Promise<string>;
}

/** Local repositories by name, for tests and local runs: `owner/name` -> path. */
export function localRepoAccess(paths: Readonly<Record<string, string>>): RepoAccess {
  return {
    async remoteUrl(repo) {
      const path = paths[repo];
      if (!path) throw new Error(`no local path for ${repo}`);
      return path;
    },
  };
}

/** Credentials in URLs (https://user:token@host) never reach logs or errors. */
export function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
}

export class GitError extends Error {}

const BOT = { name: 'software-factory[bot]', email: 'software-factory@users.noreply.github.com' };

/**
 * A throwaway clone of one target repository. Every step gets its own: steps
 * may run on different workers, so nothing is shared through the disk.
 */
export class Workspace {
  readonly dir: string;
  readonly #signal: AbortSignal | undefined;

  private constructor(dir: string, signal: AbortSignal | undefined) {
    this.dir = dir;
    this.#signal = signal;
  }

  /** Clones `branch` of the remote into a fresh temp directory. */
  static async clone(remoteUrl: string, branch: string, signal?: AbortSignal): Promise<Workspace> {
    const parent = await mkdtemp(join(tmpdir(), 'factory-'));
    const workspace = new Workspace(join(parent, 'repo'), signal);
    try {
      await git(parent, ['clone', '--quiet', '--no-tags', '--branch', branch, remoteUrl, 'repo'], signal);
    } catch (error) {
      await rm(parent, { recursive: true, force: true });
      throw error;
    }
    return workspace;
  }

  git(args: readonly string[]): Promise<string> {
    return git(this.dir, args, this.#signal);
  }

  async headSha(ref = 'HEAD'): Promise<string> {
    return (await this.git(['rev-parse', ref])).trim();
  }

  /**
   * Switches to the factory branch: its existing tip when an earlier attempt
   * pushed one (so the next attempt fixes rather than starts over), otherwise
   * a new branch from the current HEAD.
   */
  async useBranch(branch: string): Promise<'continued' | 'created'> {
    const remote = (await this.git(['ls-remote', '--heads', 'origin', branch])).trim();
    if (remote) {
      await this.git(['fetch', '--quiet', 'origin', branch]);
      await this.git(['checkout', '--quiet', '-B', branch, 'FETCH_HEAD']);
      return 'continued';
    }
    await this.git(['checkout', '--quiet', '-B', branch]);
    return 'created';
  }

  /** Detached checkout of an exact commit on `branch`, fetching the branch if the commit is missing. */
  async checkoutCommit(sha: string, branch: string): Promise<void> {
    const present = await this.git(['cat-file', '-e', `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!present) {
      await this.git(['fetch', '--quiet', 'origin', branch]);
    }
    await this.git(['checkout', '--quiet', '--detach', sha]);
  }

  /**
   * Commits everything the implementer changed, as the factory's bot, with
   * trailers that tie the commit to its run and attempt. Returns null when
   * nothing changed.
   */
  async commitAll(subject: string, trailers: Readonly<Record<string, string>>): Promise<string | null> {
    await this.git(['add', '--all']);
    if ((await this.git(['status', '--porcelain'])).trim() === '') {
      return null;
    }
    const message = [subject, '', ...Object.entries(trailers).map(([k, v]) => `${k}: ${v}`)].join('\n');
    await this.git([
      '-c',
      `user.name=${BOT.name}`,
      '-c',
      `user.email=${BOT.email}`,
      'commit',
      '--quiet',
      '--no-verify',
      '--message',
      message,
    ]);
    return this.headSha();
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  }

  /** Paths changed between two commits. */
  async changedPaths(base: string, head: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', '--no-renames', base, head]);
    return out.split('\n').filter(Boolean);
  }

  /** Lines added between two commits, per file, with their new line numbers. */
  async addedLines(base: string, head: string): Promise<ChangedFile[]> {
    return parseAddedLines(await this.git(['diff', '--unified=0', '--no-renames', '--no-color', base, head]));
  }

  /** Every tracked test file at HEAD, for the traceability gate. */
  async testFiles(maxBytes = 512_000): Promise<TestFile[]> {
    const paths = (await this.git(['ls-files'])).split('\n').filter((p) => p && isTestFile(p));
    const files: TestFile[] = [];
    for (const path of paths) {
      const content = await readFile(join(this.dir, path), 'utf8');
      if (content.length <= maxBytes) files.push({ path, content });
    }
    return files;
  }

  async dispose(): Promise<void> {
    await rm(join(this.dir, '..'), { recursive: true, force: true });
  }
}

export function parseAddedLines(diff: string): ChangedFile[] {
  const files: { path: string; addedLines: { line: number; text: string }[] }[] = [];
  let current: (typeof files)[number] | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4);
      current = path === '/dev/null' ? null : { path: path.replace(/^b\//, ''), addedLines: [] };
      if (current) files.push(current);
    } else if (raw.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (current && raw.startsWith('+')) {
      current.addedLines.push({ line, text: raw.slice(1) });
      line++;
    }
  }
  return files;
}

function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        signal,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...networkEnv(),
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          LANG: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new GitError(redact(`git ${args[0]} failed: ${stderr || error.message}`.trim())));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
