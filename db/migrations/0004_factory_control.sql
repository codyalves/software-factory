-- 0004_factory_control: a pause switch and a daily spend cap.
--
-- One row holds the factory's operating state. Workers check it before they
-- claim a step and the outbox relay checks it before it sends, so pausing stops
-- every call to the model API and to GitHub. Webhooks are still recorded while
-- paused; the work waits in the queue.
--
-- The factory starts paused: nothing spends money until a person resumes it.

create table factory_control (
    id                boolean primary key default true check (id),
    paused            boolean not null default true,
    reason            text,
    changed_by        text not null,
    changed_at        timestamptz not null default now(),
    daily_budget_usd  numeric(10, 2) not null default 3.00 check (daily_budget_usd >= 0),
    budget_time_zone  text not null default 'UTC'
);

insert into factory_control (paused, reason, changed_by)
values (true, 'initial state: paused until resumed', 'migration 0004');

-- "Spent today" sums the ledger by time; "spent on this run" sums it by run.
create index cost_ledger_at_idx on cost_ledger (at);
create index cost_ledger_run_idx on cost_ledger (run_id);
