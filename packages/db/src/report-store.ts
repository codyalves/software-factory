import type { AcceptanceCriterion, RunState } from '@factory/domain';
import { type Kysely, sql } from 'kysely';
import type { Database } from './database.ts';

/**
 * Read-only views over the factory's record, for the dashboard and reports.
 * Nothing here writes. Every figure is derived from the tables the factory
 * already keeps (runs, the audit chain, gate results, trace links, the cost
 * ledger, the outbox), so a report can always be checked against its source.
 */

export interface RunListItem {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly state: RunState;
  readonly riskLevel: 'low' | 'medium' | 'high' | null;
  readonly implementAttempts: number;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly pullRequestUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StateChange {
  readonly at: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface DecisionRecord {
  readonly question: string;
  readonly choice: string;
  readonly probability: number;
  readonly confident: boolean;
  readonly threshold: number;
  readonly engine: string;
  readonly engineVersion: string;
  readonly promptVersion: string | null;
  readonly questionVersion: string | null;
}

export interface GateRecord {
  readonly gate: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly details: string;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly commitSha: string | null;
  readonly committed: boolean;
  readonly implementer: string | null;
  readonly summary: string | null;
  readonly gates: readonly GateRecord[];
  readonly risk: {
    readonly predicted: string | null;
    readonly measured: string;
    readonly final: string;
    readonly reasons: readonly string[];
  } | null;
}

export interface TraceRow {
  readonly criterionId: string;
  readonly criterion: string;
  readonly tests: readonly { readonly testId: string; readonly commitSha: string }[];
}

export interface AuditEventSummary {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly payload: unknown;
  readonly hash: string;
}

export interface RunReport extends RunListItem {
  readonly body: string;
  readonly branch: string | null;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly timeline: readonly StateChange[];
  readonly decisions: readonly DecisionRecord[];
  readonly triage: { readonly riskFactors: readonly string[]; readonly fallbacks: readonly string[] } | null;
  readonly attempts: readonly AttemptRecord[];
  readonly trace: readonly TraceRow[];
  readonly costByModel: readonly { readonly model: string; readonly usd: number; readonly calls: number }[];
  readonly messages: readonly {
    readonly kind: string;
    readonly status: 'sent' | 'pending' | 'failed';
    readonly url: string | null;
    readonly error: string | null;
  }[];
  readonly events: readonly AuditEventSummary[];
}

export interface TraceMatrixRow {
  readonly requirementId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly riskLevel: string | null;
  readonly latestRunId: string | null;
  readonly latestState: string | null;
  readonly pullRequestUrl: string | null;
  readonly criteria: readonly TraceRow[];
}

export interface AuditSummary {
  readonly events: number;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly headHash: string | null;
  /** Empty when the whole chain verifies inside Postgres. */
  readonly problems: readonly { readonly seq: number; readonly problem: string }[];
  readonly recent: readonly (AuditEventSummary & { readonly runId: string | null })[];
}

const iso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

/**
 * Gate results are written in one transaction with the same timestamp, so the
 * table cannot say which ran first. The gating audit event lists them in the
 * order they ran; use it.
 */
function inRunOrder(gates: GateRecord[], order: readonly string[]): GateRecord[] {
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  return [...gates].sort((a, b) => rank(a.gate) - rank(b.gate));
}

export class ReportStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  /** Runs, newest first, with spend and the pull request they opened. */
  listRuns(options: { limit?: number } = {}): Promise<RunListItem[]> {
    return this.#runs(null, Math.min(Math.max(options.limit ?? 50, 1), 500));
  }

  async #runs(runId: string | null, limit: number): Promise<RunListItem[]> {
    const { rows } = await sql<{
      id: string;
      repo: string;
      issue_number: number;
      title: string;
      state: RunState;
      risk_level: RunListItem['riskLevel'];
      implement_attempts: number;
      spent: string;
      budget_usd: string;
      pr_url: string | null;
      created_at: Date;
      updated_at: Date;
    }>`
      select r.id, q.repo, q.issue_number, q.title, r.state, q.risk_level, r.implement_attempts,
             r.budget_usd::text as budget_usd, r.created_at, r.updated_at,
             coalesce((select sum(usd) from cost_ledger c where c.run_id = r.id), 0)::text as spent,
             (select o.result ->> 'url' from outbox o
               where o.run_id = r.id and o.kind = 'pull_request.open' and o.sent_at is not null
               order by o.id desc limit 1) as pr_url
      from run r join requirement q on q.id = r.requirement_id
      where (${runId}::uuid is null or r.id = ${runId}::uuid)
      order by r.created_at desc
      limit ${limit}
    `.execute(this.#db);
    return rows.map((r) => ({
      id: r.id,
      repo: r.repo,
      issueNumber: r.issue_number,
      title: r.title,
      state: r.state,
      riskLevel: r.risk_level,
      implementAttempts: r.implement_attempts,
      spentUsd: Number(r.spent),
      budgetUsd: Number(r.budget_usd),
      pullRequestUrl: r.pr_url,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    }));
  }

  /** Everything recorded about one run, or null if there is no such run. */
  async runReport(runId: string): Promise<RunReport | null> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
    const head = (await this.#runs(runId, 1))[0];
    if (!head) return null;

    const detail = await this.#db
      .selectFrom('run')
      .innerJoin('requirement', 'requirement.id', 'run.requirement_id')
      .select([
        'requirement.id as requirement_id',
        'requirement.body',
        'requirement.criteria',
        'run.branch',
        'run.base_sha',
        'run.head_sha',
      ])
      .where('run.id', '=', runId)
      .executeTakeFirstOrThrow();

    const events = await this.#runEvents(runId);
    const ofType = (type: string) =>
      events.filter((e) => e.type === type).map((e) => ({ ...e, p: object(e.payload) }));

    const timeline = ofType('run.state_changed').map((e) => ({
      at: e.at,
      from: text(e.p.from),
      to: text(e.p.to),
      reason: text(e.p.reason),
    }));

    // A re-triaged run keeps every decision in the log; show the latest triage.
    const triageEvents = ofType('triage.completed');
    const lastTriage = triageEvents.at(-1);
    const decisions = ofType('decision.made')
      .filter((e) => !lastTriage || e.seq < lastTriage.seq)
      .slice(-7)
      .map((e) => ({
        question: text(e.p.question),
        choice: text(e.p.choice),
        probability: Number(e.p.probability),
        confident: e.p.confident === true,
        threshold: Number(e.p.threshold),
        engine: text(e.p.engine),
        engineVersion: text(e.p.engineVersion),
        promptVersion: typeof e.p.promptVersion === 'string' ? e.p.promptVersion : null,
        questionVersion: typeof e.p.questionVersion === 'string' ? e.p.questionVersion : null,
      }));

    const gateRows = await this.#db
      .selectFrom('gate_result')
      .select(['attempt', 'gate', 'passed', 'summary', 'details'])
      .where('run_id', '=', runId)
      .orderBy('attempt')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const committed = ofType('implementation.committed');
    const gated = ofType('gating.completed');
    const attemptNumbers = [
      ...new Set([
        ...committed.map((e) => Number(e.p.attempt)),
        ...gateRows.map((g) => g.attempt ?? 0).filter((a) => a > 0),
      ]),
    ].sort((a, b) => a - b);
    const attempts: AttemptRecord[] = attemptNumbers.map((attempt) => {
      const commit = committed.find((e) => Number(e.p.attempt) === attempt)?.p;
      const gating = gated.find((e) => Number(e.p.attempt) === attempt)?.p;
      const risk = gating ? object(gating.risk) : null;
      return {
        attempt,
        commitSha: commit ? text(commit.commitSha) || null : null,
        committed: commit?.committed === true,
        implementer: commit ? text(commit.implementer) || null : null,
        summary: commit ? text(commit.summary) || null : null,
        gates: inRunOrder(
          gateRows
            .filter((g) => g.attempt === attempt)
            .map((g) => ({ gate: g.gate, passed: g.passed, summary: g.summary, details: g.details })),
          gating ? (Array.isArray(gating.gates) ? gating.gates.map((g) => text(object(g).gate)) : []) : [],
        ),
        risk:
          risk && typeof risk.measured === 'string'
            ? {
                predicted: typeof risk.predicted === 'string' ? risk.predicted : null,
                measured: risk.measured,
                final: text(risk.final),
                reasons: strings(risk.reasons),
              }
            : null,
      };
    });

    const criteria = Array.isArray(detail.criteria) ? (detail.criteria as AcceptanceCriterion[]) : [];
    const cost = await sql<{ model: string; usd: string; calls: string }>`
      select model, sum(usd)::text as usd, count(*)::text as calls
      from cost_ledger where run_id = ${runId}::uuid group by model order by sum(usd) desc
    `.execute(this.#db);
    const outbox = await this.#db
      .selectFrom('outbox')
      .select(['kind', 'sent_at', 'failed_at', 'result', 'last_error'])
      .where('run_id', '=', runId)
      .orderBy('id')
      .execute();

    const lastTriagePayload = lastTriage?.p;
    return {
      ...head,
      body: detail.body,
      branch: detail.branch,
      baseSha: detail.base_sha,
      headSha: detail.head_sha,
      criteria,
      timeline,
      decisions,
      triage: lastTriagePayload
        ? {
            riskFactors: strings(lastTriagePayload.riskFactors),
            fallbacks: strings(lastTriagePayload.fallbacks),
          }
        : null,
      attempts,
      trace: await this.#trace(detail.requirement_id, criteria),
      costByModel: cost.rows.map((r) => ({ model: r.model, usd: Number(r.usd), calls: Number(r.calls) })),
      messages: outbox.map((m) => ({
        kind: m.kind,
        status: m.sent_at ? 'sent' : m.failed_at ? 'failed' : 'pending',
        url: text(object(m.result).url) || null,
        error: m.last_error,
      })),
      events,
    };
  }

  /** Every requirement with its criteria, the tests that cover them, and its latest run. */
  async traceMatrix(): Promise<TraceMatrixRow[]> {
    const { rows } = await sql<{
      id: string;
      repo: string;
      issue_number: number;
      title: string;
      risk_level: string | null;
      criteria: unknown;
      run_id: string | null;
      state: string | null;
    }>`
      select q.id, q.repo, q.issue_number, q.title, q.risk_level, q.criteria, r.id as run_id, r.state
      from requirement q
      left join lateral (
        select id, state from run where run.requirement_id = q.id order by created_at desc limit 1
      ) r on true
      order by q.created_at desc
    `.execute(this.#db);
    const result: TraceMatrixRow[] = [];
    for (const row of rows) {
      const criteria = Array.isArray(row.criteria) ? (row.criteria as AcceptanceCriterion[]) : [];
      const pr = row.run_id
        ? await this.#db
            .selectFrom('outbox')
            .select('result')
            .where('run_id', '=', row.run_id)
            .where('kind', '=', 'pull_request.open')
            .where('sent_at', 'is not', null)
            .executeTakeFirst()
        : undefined;
      result.push({
        requirementId: row.id,
        repo: row.repo,
        issueNumber: row.issue_number,
        title: row.title,
        riskLevel: row.risk_level,
        latestRunId: row.run_id,
        latestState: row.state,
        pullRequestUrl: text(object(pr?.result).url) || null,
        criteria: await this.#trace(row.id, criteria),
      });
    }
    return result;
  }

  /** The chain's size, head and verification result, plus the latest events. */
  async auditSummary(recentLimit = 50): Promise<AuditSummary> {
    const { rows: stats } = await sql<{
      events: string;
      first_at: string | null;
      last_at: string | null;
      head: string | null;
    }>`
      select count(*)::text as events,
             to_char(min(at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_at,
             to_char(max(at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_at,
             (select hash from audit_event order by seq desc limit 1) as head
      from audit_event
    `.execute(this.#db);
    const { rows: problems } = await sql<{ seq: string; problem: string }>`
      select seq, problem from audit_verify()
    `.execute(this.#db);
    const { rows: recent } = await sql<{
      seq: string;
      at: string;
      type: string;
      payload: string;
      hash: string;
      run_id: string | null;
    }>`
      select seq, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, type, payload, hash, run_id
      from audit_event order by seq desc limit ${Math.min(Math.max(recentLimit, 1), 500)}
    `.execute(this.#db);
    const stat = stats[0];
    return {
      events: Number(stat?.events ?? 0),
      firstAt: stat?.first_at ?? null,
      lastAt: stat?.last_at ?? null,
      headHash: stat?.head?.trim() ?? null,
      problems: problems.map((p) => ({ seq: Number(p.seq), problem: p.problem })),
      recent: recent.map((e) => ({
        seq: Number(e.seq),
        at: e.at,
        type: e.type,
        payload: JSON.parse(e.payload) as unknown,
        hash: e.hash.trim(),
        runId: e.run_id,
      })),
    };
  }

  async #runEvents(runId: string): Promise<AuditEventSummary[]> {
    const { rows } = await sql<{ seq: string; at: string; type: string; payload: string; hash: string }>`
      select seq, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, type, payload, hash
      from audit_event where run_id = ${runId}::uuid order by seq
    `.execute(this.#db);
    return rows.map((e) => ({
      seq: Number(e.seq),
      at: e.at,
      type: e.type,
      payload: JSON.parse(e.payload) as unknown,
      hash: e.hash.trim(),
    }));
  }

  async #trace(requirementId: string, criteria: readonly AcceptanceCriterion[]): Promise<TraceRow[]> {
    const links = await this.#db
      .selectFrom('trace_link')
      .select(['criterion_id', 'test_id', 'commit_sha'])
      .where('requirement_id', '=', requirementId)
      .orderBy('criterion_id')
      .orderBy('test_id')
      .execute();
    return criteria.map((c) => ({
      criterionId: c.id,
      criterion: c.text,
      tests: links
        .filter((l) => l.criterion_id === c.id)
        .map((l) => ({ testId: l.test_id, commitSha: l.commit_sha })),
    }));
  }
}
