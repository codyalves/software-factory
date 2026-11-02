-- 0001_init: core schema for runs, evidence and the hash-chained audit log.
-- Applied by Factory.Infrastructure.Persistence.Migrator inside one transaction.

-- ---------------------------------------------------------------------------
-- Requirements and runs
-- ---------------------------------------------------------------------------

create table requirement (
    id            uuid primary key default gen_random_uuid(),
    repo          text not null,
    issue_number  int  not null,
    title         text not null,
    body          text not null default '',
    criteria      jsonb not null default '[]',
    risk_level    text check (risk_level in ('low', 'medium', 'high')),
    created_at    timestamptz not null default now(),
    unique (repo, issue_number)
);

create table run (
    id                uuid primary key default gen_random_uuid(),
    requirement_id    uuid not null references requirement (id),
    state             text not null check (state in (
                          'Intake', 'Triage', 'Planning', 'Implementing', 'Gating',
                          'Reviewing', 'Merging', 'Merged', 'Escalated', 'Rejected', 'Cancelled')),
    implement_attempts int not null default 0,
    base_sha          text,
    model             text,
    prompt_version    text,
    budget_usd        numeric(10, 2) not null default 5.00,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create index run_state_idx on run (state, created_at);

-- At most one active run per requirement.
create unique index run_one_active_per_requirement on run (requirement_id)
    where state not in ('Merged', 'Escalated', 'Rejected', 'Cancelled');

create table step (
    id               uuid primary key default gen_random_uuid(),
    run_id           uuid not null references run (id),
    kind             text not null,
    status           text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'dead_lettered')),
    attempt          int  not null default 1,
    idempotency_key  text not null unique,
    lease_until      timestamptz,
    last_error       text,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index step_status_idx on step (status, lease_until);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

create table artifact (
    sha256      char(64) primary key,
    kind        text   not null,
    bytes       bigint not null,
    uri         text   not null,
    created_at  timestamptz not null default now()
);

create table gate_result (
    id            uuid primary key default gen_random_uuid(),
    step_id       uuid not null references step (id),
    gate          text not null,
    passed        boolean not null,
    summary       text not null default '',
    artifact_sha  char(64) references artifact (sha256),
    created_at    timestamptz not null default now()
);

create table trace_link (
    requirement_id  uuid not null references requirement (id),
    criterion_id    text not null,
    test_id         text not null,
    commit_sha      text not null,
    created_at      timestamptz not null default now(),
    primary key (requirement_id, criterion_id, test_id)
);

create table cost_ledger (
    id          bigint generated always as identity,
    run_id      uuid not null,
    step_id     uuid,
    model       text not null,
    tokens_in   int  not null default 0,
    tokens_out  int  not null default 0,
    usd         numeric(12, 6) not null default 0,
    at          timestamptz not null default now(),
    primary key (id, at)
) partition by range (at);

create table cost_ledger_default partition of cost_ledger default;

-- ---------------------------------------------------------------------------
-- Integration plumbing
-- ---------------------------------------------------------------------------

-- Webhook deliveries already processed, so a redelivered webhook is a no-op.
create table inbound_delivery (
    delivery_id  text primary key,
    source       text not null,
    received_at  timestamptz not null default now()
);

-- Transactional outbox: side effects (PR comments, merges) are written here in
-- the same transaction as the state change, then published by a relay.
create table outbox (
    id          bigint generated always as identity primary key,
    run_id      uuid not null references run (id),
    kind        text not null,
    payload     jsonb not null,
    attempts    int  not null default 0,
    created_at  timestamptz not null default now(),
    sent_at     timestamptz
);

create index outbox_unsent_idx on outbox (created_at) where sent_at is null;

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained
-- ---------------------------------------------------------------------------
--
-- hash = sha256(prev_hash \n seq \n at \n run_id \n type \n payload), hex.
--   at      : UTC, 'YYYY-MM-DDTHH:MM:SS.ffffffZ'
--   run_id  : lowercase uuid, or '' when the event is not tied to a run
--   payload : canonical JSON text (sorted keys, no whitespace), stored verbatim
--
-- The same formula lives in Factory.Domain.Audit.AuditChain so exported chains
-- can be verified outside the database. Do not change it without a new
-- chain version.

create table audit_event (
    seq           bigint      not null,
    at            timestamptz not null,
    run_id        uuid,
    type          text        not null,
    payload       text        not null,
    payload_json  jsonb generated always as (payload::jsonb) stored,
    prev_hash     char(64)    not null,
    hash          char(64)    not null,
    primary key (seq, at)
) partition by range (at);

create table audit_event_default partition of audit_event default;

create index audit_event_run_idx on audit_event (run_id, seq);

-- Monthly partitions. Rows outside them land in the default partition.
create function create_month_partitions(parent regclass, months_ahead int)
returns void
language plpgsql
as $$
declare
    month_start date;
    part_name   text;
begin
    for i in 0..months_ahead loop
        month_start := (date_trunc('month', now()) + make_interval(months => i))::date;
        part_name   := format('%s_%s', parent::text, to_char(month_start, 'YYYY_MM'));
        execute format(
            'create table if not exists %I partition of %s for values from (%L) to (%L)',
            part_name, parent, month_start, (month_start + interval '1 month')::date);
    end loop;
end;
$$;

select create_month_partitions('audit_event', 2);
select create_month_partitions('cost_ledger', 2);

create function audit_hash(
    prev_hash text, seq bigint, at timestamptz, run_id uuid, type text, payload text)
returns char(64)
language sql
immutable
as $$
    select encode(sha256(convert_to(concat_ws(E'\n',
        prev_hash,
        seq::text,
        to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        coalesce(run_id::text, ''),
        type,
        payload), 'UTF8')), 'hex');
$$;

-- The only supported way to write an audit event. Serializes appends with a
-- transaction-scoped advisory lock so seq and prev_hash form a single chain.
create function audit_append(p_run_id uuid, p_type text, p_payload text)
returns audit_event
language plpgsql
as $$
declare
    v_prev audit_event;
    v_row  audit_event;
    v_at   timestamptz := date_trunc('microseconds', now());
begin
    perform pg_advisory_xact_lock(hashtext('audit_event_chain'));

    -- Rejects anything that is not valid JSON.
    perform p_payload::jsonb;

    select * into v_prev from audit_event order by seq desc limit 1;

    v_row.seq       := coalesce(v_prev.seq, 0) + 1;
    v_row.at        := greatest(v_at, coalesce(v_prev.at, v_at));
    v_row.run_id    := p_run_id;
    v_row.type      := p_type;
    v_row.payload   := p_payload;
    v_row.prev_hash := coalesce(v_prev.hash, repeat('0', 64));
    v_row.hash      := audit_hash(v_row.prev_hash, v_row.seq, v_row.at, p_run_id, p_type, p_payload);

    insert into audit_event (seq, at, run_id, type, payload, prev_hash, hash)
    values (v_row.seq, v_row.at, v_row.run_id, v_row.type, v_row.payload, v_row.prev_hash, v_row.hash)
    returning * into v_row;

    return v_row;
end;
$$;

-- Recomputes every hash and checks the links. Returns one row per problem;
-- an empty result means the chain is intact.
create function audit_verify()
returns table (seq bigint, problem text)
language sql
stable
as $$
    with ordered as (
        select e.*,
               lag(e.hash) over (order by e.seq) as expected_prev,
               lag(e.seq)  over (order by e.seq) as previous_seq
        from audit_event e
    )
    select o.seq,
           case
               when o.previous_seq is null and o.seq <> 1        then 'chain does not start at seq 1'
               when o.previous_seq is not null and o.seq <> o.previous_seq + 1 then 'gap in sequence'
               when o.prev_hash <> coalesce(o.expected_prev, repeat('0', 64)) then 'prev_hash does not match previous event'
               else 'hash does not match contents'
           end
    from ordered o
    where (o.previous_seq is null and o.seq <> 1)
       or (o.previous_seq is not null and o.seq <> o.previous_seq + 1)
       or o.prev_hash <> coalesce(o.expected_prev, repeat('0', 64))
       or o.hash <> audit_hash(o.prev_hash, o.seq, o.at, o.run_id, o.type, o.payload)
    order by o.seq;
$$;

-- Append-only enforcement. Row triggers on a partitioned table are cloned to
-- every partition, so updating a partition directly is blocked too.
create function audit_event_forbid_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception 'audit_event is append-only: % is not allowed', tg_op
        using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_event_no_update_or_delete
    before update or delete on audit_event
    for each row execute function audit_event_forbid_mutation();

-- Statement-level TRUNCATE triggers are not cloned to partitions, so each
-- audit partition gets its own.
create function audit_guard_truncate(target regclass)
returns void
language plpgsql
as $$
begin
    execute format(
        'create or replace trigger audit_event_no_truncate before truncate on %s '
        'for each statement execute function audit_event_forbid_mutation()', target);
end;
$$;

select audit_guard_truncate(c.oid::regclass)
from pg_class c
where c.oid = 'audit_event'::regclass
   or c.oid in (select inhrelid from pg_inherits where inhparent = 'audit_event'::regclass);

-- New monthly audit partitions created later must also call audit_guard_truncate.
