import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A versioned prompt, identified by file name and content hash. */
export interface Prompt {
  readonly text: string;
  /** e.g. `triage.v1@3f2a9c1e5b7d`: the name plus the first 12 hex of its SHA-256. */
  readonly version: string;
}

/**
 * Loads prompts/<name>.md. The content hash goes into every decision's audit
 * record, so it is provable which exact prompt produced it, even if someone
 * edits a file without renaming it.
 */
export async function loadPrompt(promptsDir: string, name: string): Promise<Prompt> {
  const text = await readFile(join(promptsDir, `${name}.md`), 'utf8');
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');
  return { text, version: `${name}@${sha.slice(0, 12)}` };
}
