-- 0005_implement_loop: what the implement-and-gate loop needs to record.
--
-- A run loops Implementing -> Gating -> Implementing, so it accumulates
-- finished steps of the same kind. consumed_at marks the step whose result
-- the orchestrator has applied, so an earlier attempt's step is never
-- applied twice.

alter table step add column consumed_at timestamptz;
create index step_unconsumed_idx on step (run_id, kind) where consumed_at is null;

-- The branch the factory pushes each attempt to, and the commit gates ran on.
alter table run add column branch text;
alter table run add column head_sha text;

-- Which attempt a gate result belongs to, and the output the implementer saw.
alter table gate_result add column run_id uuid references run (id);
alter table gate_result add column attempt int;
alter table gate_result add column details text not null default '';
create index gate_result_run_idx on gate_result (run_id, attempt);
