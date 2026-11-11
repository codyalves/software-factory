-- 0006_tester: what the tester needs.
--
-- The tester files issues that belong to no run yet, so outbox messages may
-- have no run. Requirements record who opened the issue, and the regression
-- test the tester attached when the author is the factory's own App: that
-- test is committed before the implementer starts and may not be changed.

alter table outbox alter column run_id drop not null;

alter table requirement add column author text;
alter table requirement add column regression jsonb;
