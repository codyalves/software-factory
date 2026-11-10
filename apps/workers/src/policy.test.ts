import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, TEST_DATABASE_URL } from '@factory/db/testing';
import { BUILT_IN_GATES, DEFAULT_CONFIDENCE_THRESHOLD, MAX_IMPLEMENT_ATTEMPTS } from '@factory/domain';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_ATTEMPT_BUDGET_USD, DEFAULT_ESCALATE_AFTER } from './claude-code-implementer.ts';

/**
 * gates/gates.yaml is the policy a reviewer reads. These tests pin every
 * "enforced" value to the code or database default that enforces it, so the
 * document cannot promise something the factory does not do.
 */
const policySchema = z.object({
  version: z.literal(2),
  enforced: z.object({
    iteration: z.object({
      max_implement_attempts: z.number(),
      escalate_to_frontier_after_failures: z.number(),
    }),
    budget: z.object({ per_attempt_usd: z.number(), per_run_usd: z.number(), per_day_usd: z.number() }),
    decision_layer: z.object({ confidence_threshold: z.number(), engine: z.string() }),
    gates: z.array(z.string()),
    risk: z.object({ predicted_by: z.literal('triage'), measured_from: z.literal('diff') }),
    merge_policy: z.object({ auto_merge_risk_levels: z.array(z.string()) }),
  }),
  planned: z.record(z.string(), z.unknown()),
});

async function policy() {
  const path = fileURLToPath(new URL('../../../gates/gates.yaml', import.meta.url));
  return policySchema.parse(parse(await readFile(path, 'utf8'))).enforced;
}

describe('gates/gates.yaml', () => {
  it('states the iteration limits the code enforces', async () => {
    const { iteration } = await policy();

    expect(iteration.max_implement_attempts).toBe(MAX_IMPLEMENT_ATTEMPTS);
    expect(iteration.escalate_to_frontier_after_failures).toBe(DEFAULT_ESCALATE_AFTER);
  });

  it('states the per-attempt budget and confidence threshold the code uses', async () => {
    const { budget, decision_layer } = await policy();

    expect(budget.per_attempt_usd).toBe(DEFAULT_ATTEMPT_BUDGET_USD);
    expect(decision_layer.confidence_threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('lists exactly the built-in gates', async () => {
    expect((await policy()).gates).toEqual([...BUILT_IN_GATES]);
  });

  it('promises no auto-merge, because the factory never merges', async () => {
    expect((await policy()).merge_policy.auto_merge_risk_levels).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('gates/gates.yaml budgets', () => {
  it('match the database defaults that enforce them', async () => {
    await using t = await createTestDatabase();
    const { budget } = await policy();

    const { rows } = await sql<{ table_name: string; column_default: string }>`
      select table_name, column_default from information_schema.columns
      where (table_name, column_name) in (('run', 'budget_usd'), ('factory_control', 'daily_budget_usd'))
    `.execute(t.db);
    const defaults = Object.fromEntries(rows.map((r) => [r.table_name, Number.parseFloat(r.column_default)]));

    expect(defaults.run).toBe(budget.per_run_usd);
    expect(defaults.factory_control).toBe(budget.per_day_usd);
  });
});
