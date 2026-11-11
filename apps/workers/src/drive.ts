import type { AuditEvent } from '@factory/domain';

/**
 * Drives one run to a resting state in a single process: the orchestrator's
 * transitions first, then one worker step, repeated until nothing moves.
 * Used for manual runs (the factory-run workflow) and end-to-end tests; the
 * long-running services do the same work in separate loops.
 */
export async function driveRun(options: {
  /** Orchestrator transitions and the outbox relay; each returns a description or null. */
  readonly transitions: readonly (() => Promise<string | null>)[];
  /** Claims and runs one worker step; false when none is ready. */
  readonly work: () => Promise<boolean>;
  /** True once the run has reached a state where the factory stops (Reviewing, Escalated, ...). */
  readonly finished: () => Promise<boolean>;
  readonly maxRounds: number;
  readonly log: (line: string) => void;
}): Promise<{ readonly rounds: number; readonly finished: boolean }> {
  for (let round = 1; round <= options.maxRounds; round++) {
    let moved = false;
    for (const transition of options.transitions) {
      let description = await transition();
      while (description) {
        options.log(description);
        moved = true;
        description = await transition();
      }
    }
    if (await options.finished()) {
      return { rounds: round, finished: true };
    }
    if (await options.work()) {
      moved = true;
    }
    if (!moved) {
      return { rounds: round, finished: false };
    }
  }
  return { rounds: options.maxRounds, finished: false };
}

interface Parsed {
  readonly at: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const cell = (value: unknown) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');

/**
 * A Markdown account of one run, built only from its audit events: the
 * states it passed through, each triage decision, each attempt's gates,
 * and the traceability record.
 */
export function renderRunReport(
  events: readonly AuditEvent[],
  extras: {
    readonly title: string;
    readonly spentUsd: number;
    readonly pullRequestUrl: string | null;
    readonly chainValid: boolean;
  },
): string {
  const parsed: Parsed[] = events.map((e) => ({
    at: e.at,
    type: e.type,
    payload: JSON.parse(e.payload) as Record<string, unknown>,
  }));
  const of = (type: string) => parsed.filter((e) => e.type === type);
  const states = of('run.state_changed');
  const last = states.at(-1)?.payload;

  const lines = [
    `## Factory run: ${extras.title}`,
    '',
    `- **Final state: ${String(last?.to ?? 'Intake')}**${last?.reason ? `: ${cell(last.reason)}` : ''}`,
    `- Pull request: ${extras.pullRequestUrl ?? 'none'}`,
    `- Implement attempts: ${String(last?.implementAttempts ?? 0)}`,
    `- Spent: $${extras.spentUsd.toFixed(4)} at list prices`,
    `- Audit chain: ${extras.chainValid ? 'whole record valid' : '**INVALID**'}; this run added ${events.length} events`,
    '',
    '### States',
    '',
    '| Time (UTC) | From | To | Why |',
    '| --- | --- | --- | --- |',
    ...states.map(
      (s) =>
        `| ${s.at.slice(11, 19)} | ${cell(s.payload.from)} | ${cell(s.payload.to)} | ${cell(s.payload.reason)} |`,
    ),
  ];

  const decisions = of('decision.made');
  if (decisions.length > 0) {
    lines.push(
      '',
      '### Triage decisions',
      '',
      '| Question | Answer | Probability | Confident |',
      '| --- | --- | --- | --- |',
    );
    for (const d of decisions) {
      lines.push(
        `| ${cell(d.payload.question)} | ${cell(d.payload.choice)} | ${Number(d.payload.probability).toFixed(2)} | ${d.payload.confident ? 'yes' : 'no'} |`,
      );
    }
  }

  const gating = of('gating.completed');
  if (gating.length > 0) {
    lines.push('', '### Gates by attempt', '');
    for (const g of gating) {
      const gates = (g.payload.gates ?? []) as { gate: string; passed: boolean; summary: string }[];
      lines.push(
        `**Attempt ${String(g.payload.attempt)}** (\`${String(g.payload.commitSha).slice(0, 12)}\`): ${gates.every((x) => x.passed) ? 'all passed' : 'failed'}`,
        '',
        ...gates.map((x) => `- ${x.passed ? 'pass' : '**FAIL**'} ${x.gate}: ${cell(x.summary)}`),
        '',
      );
    }
  }

  const trace = of('traceability.recorded').at(-1);
  if (trace) {
    const links = (trace.payload.links ?? []) as { criterionId: string; testId: string }[];
    lines.push('### Traceability', '', '| Criterion | Test | Commit |', '| --- | --- | --- |');
    for (const l of links)
      lines.push(
        `| ${l.criterionId} | \`${l.testId}\` | \`${String(trace.payload.commitSha).slice(0, 12)}\` |`,
      );
    lines.push('');
  }
  return lines.join('\n');
}
