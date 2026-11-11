import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunIssue } from '@factory/db';
import { z } from 'zod';
import { runGates, type TargetConfig } from '../gates.ts';
import type { Implementer } from '../implementer.ts';
import { StepError, type StepHandler } from '../step-runner.ts';
import { type RepoAccess, Workspace } from '../workspace.ts';

export const IMPLEMENT_STEP = 'implement';
export const GATE_STEP = 'gate';

export interface DeliveryDeps {
  readonly loadIssue: (runId: string) => Promise<RunIssue | null>;
  readonly targets: Readonly<Record<string, TargetConfig>>;
  readonly access: RepoAccess;
}

/** The branch every attempt of a run is pushed to. */
export function factoryBranch(issueNumber: number, runId: string): string {
  return `factory/${issueNumber}-${runId.slice(0, 8)}`;
}

const implementPayload = z.object({
  attempt: z.number().int().positive(),
  feedback: z.string().nullable(),
});

async function context(deps: DeliveryDeps, runId: string) {
  const issue = await deps.loadIssue(runId);
  if (!issue) {
    throw new StepError(`run ${runId} has no issue`, { failureClass: 'permanent' });
  }
  const target = deps.targets[issue.repo];
  if (!target) {
    throw new StepError(`${issue.repo} is not a configured target (gates/targets.json)`, {
      failureClass: 'permanent',
    });
  }
  return { issue, target, remote: await deps.access.remoteUrl(issue.repo) };
}

/**
 * One implement attempt: check out the run's branch (continuing an earlier
 * attempt if there was one), let the implementer change the code, then commit
 * and push whatever it left. An attempt that changes nothing still succeeds,
 * with no commit; the gates fail it and the loop decides what happens next.
 */
export function createImplementHandler(
  deps: DeliveryDeps & { readonly implementer: Implementer },
): StepHandler {
  return async (step, { signal, recordUsage }) => {
    const { attempt, feedback } = implementPayload.parse(step.payload);
    const { issue, target, remote } = await context(deps, step.runId);
    const branch = factoryBranch(issue.issueNumber, step.runId);

    const workspace = await Workspace.clone(remote, target.baseBranch, signal);
    try {
      let baseSha = await workspace.headSha();
      const started = await workspace.useBranch(branch);
      if (started === 'created' && issue.regression) {
        // The tester's regression test goes in first, as its own commit, and
        // becomes the base the attempt is judged against: protected-paths
        // then catches any change the implementer makes to it.
        await mkdir(dirname(join(workspace.dir, issue.regression.path)), { recursive: true });
        await writeFile(join(workspace.dir, issue.regression.path), issue.regression.content);
        const seeded = await workspace.commitAll(
          `Add the tester's regression test for #${issue.issueNumber}`,
          {
            'Factory-Run': step.runId,
            'Factory-Regression': issue.regression.path,
          },
        );
        if (seeded) {
          await workspace.push(branch);
          baseSha = seeded;
        }
      }
      const { summary } = await deps.implementer.implement(
        {
          dir: workspace.dir,
          issue: { repo: issue.repo, number: issue.issueNumber, title: issue.title, body: issue.body },
          criteria: issue.criteria,
          attempt,
          feedback,
          commands: [...target.setup, ...Object.values(target.gates)],
          protectedPaths: target.protectedPaths,
        },
        { signal, recordUsage },
      );
      const commitSha = await workspace.commitAll(
        `Attempt ${attempt} at #${issue.issueNumber}: ${issue.title}`,
        {
          'Factory-Run': step.runId,
          'Factory-Attempt': String(attempt),
          'Factory-Implementer': deps.implementer.name,
        },
      );
      if (commitSha) {
        await workspace.push(branch);
      }
      return {
        attempt,
        branch,
        baseBranch: target.baseBranch,
        baseSha,
        // With no new commit, the branch tip (or base) is what gets judged.
        commitSha: commitSha ?? (await workspace.headSha()),
        committed: commitSha !== null,
        continued: started === 'continued',
        implementer: deps.implementer.name,
        summary: summary.slice(0, 4_000),
      };
    } finally {
      await workspace.dispose();
    }
  };
}

const gatePayload = z.object({
  attempt: z.number().int().positive(),
  branch: z.string(),
  baseBranch: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
});

/** Runs every gate on the attempt's commit, in a fresh clone. */
export function createGateHandler(deps: DeliveryDeps): StepHandler {
  return async (step, { signal }) => {
    const payload = gatePayload.parse(step.payload);
    const { issue, target, remote } = await context(deps, step.runId);

    const workspace = await Workspace.clone(remote, target.baseBranch, signal);
    try {
      await workspace.checkoutCommit(payload.commitSha, payload.branch);
      const { gates, links, risk } = await runGates({
        workspace,
        target,
        criteria: issue.criteria,
        baseSha: payload.baseSha,
        headSha: payload.commitSha,
        regressionPath: issue.regression?.path ?? null,
        signal,
      });
      return { ...payload, gates, links, risk };
    } finally {
      await workspace.dispose();
    }
  };
}
