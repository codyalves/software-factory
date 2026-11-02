-- 0002_step_queue: turns the step table into a durable work queue.
--
-- Lifecycle:  queued -> running -> succeeded
--                         |  ^
--                         v  | (retry after backoff)
--                       queued ...  -> dead_lettered (permanent, or out of attempts)
--
-- A worker claims a step with FOR UPDATE SKIP LOCKED, holds a lease while it
-- runs, and extends it with heartbeats. If the lease expires (worker crashed
-- or hung), the orchestrator's reaper treats it as a transient failure.

alter table step drop constraint step_status_check;
alter table step add constraint step_status_check
    check (status in ('queued', 'running', 'succeeded', 'dead_lettered'));

-- attempt counts attempts started; a queued step that never ran has 0.
alter table step alter column attempt set default 0;

alter table step
    add column payload          jsonb       not null default '{}',
    add column max_attempts     int         not null default 5 check (max_attempts > 0),
    add column timeout_ms       int         not null default 600000 check (timeout_ms > 0),
    add column run_after        timestamptz not null default now(),
    add column lease_owner      text,
    add column heartbeat_at     timestamptz,
    add column result           jsonb,
    add column failure_class    text check (failure_class in ('transient', 'timeout', 'permanent')),
    add column finished_at      timestamptz;

drop index step_status_idx;

-- What claim scans: ready work, oldest first.
create index step_ready_idx on step (run_after, created_at) where status = 'queued';

-- What the reaper scans: running steps by lease deadline.
create index step_lease_idx on step (lease_until) where status = 'running';

create index step_dead_letter_idx on step (finished_at desc) where status = 'dead_lettered';

-- One row per attempt, kept forever: the failure capture for every retry and
-- dead letter (who ran it, when, how it ended, and the error details).
create table step_attempt (
    step_id        uuid        not null references step (id),
    attempt        int         not null,
    worker         text        not null,
    started_at     timestamptz not null default now(),
    finished_at    timestamptz,
    outcome        text check (outcome in ('succeeded', 'retry_scheduled', 'dead_lettered')),
    failure_class  text check (failure_class in ('transient', 'timeout', 'permanent')),
    error          jsonb,
    primary key (step_id, attempt)
);
