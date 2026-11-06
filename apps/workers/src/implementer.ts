import type { AcceptanceCriterion, ModelUsage } from '@factory/domain';

export interface ImplementInput {
  /** The checked-out factory branch. The implementer edits files here; the worker commits. */
  readonly dir: string;
  readonly issue: {
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
  };
  readonly criteria: readonly AcceptanceCriterion[];
  /** 1 for the first attempt. */
  readonly attempt: number;
  /** Why the previous attempt failed its gates, or null on the first attempt. */
  readonly feedback: string | null;
}

/**
 * Changes the code in a workspace to satisfy an issue. It never commits,
 * pushes or touches the run: the worker commits what it leaves behind, and
 * the gates, not the implementer, decide whether that is good enough.
 */
export interface Implementer {
  /** Recorded on every commit and audit event, e.g. "claude-code/claude-sonnet-5-5". */
  readonly name: string;
  implement(
    input: ImplementInput,
    context: { readonly signal: AbortSignal; readonly recordUsage: (usage: ModelUsage) => void },
  ): Promise<{ readonly summary: string }>;
}
