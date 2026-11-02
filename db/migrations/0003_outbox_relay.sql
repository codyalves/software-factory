-- 0003_outbox_relay: delivery state for the transactional outbox.
--
-- The relay sends one due message at a time. Success sets sent_at; a failure
-- that may succeed later pushes next_attempt_at out by the retry policy; a
-- failure that cannot succeed (or one out of attempts) sets failed_at.

alter table outbox
    add column next_attempt_at timestamptz not null default now(),
    add column last_error      text,
    add column failed_at       timestamptz,
    add column result          jsonb;

drop index outbox_unsent_idx;

create index outbox_due_idx on outbox (next_attempt_at, id)
    where sent_at is null and failed_at is null;
