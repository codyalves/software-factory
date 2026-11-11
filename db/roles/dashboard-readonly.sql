-- A login for the dashboard that can read the factory's record and nothing
-- else. Run once as the database owner (in Neon: the SQL Editor), after the
-- factory has migrated the database at least once.
--
-- Replace CHANGE_ME with a long random password before running. Do not
-- commit or share the real one; it goes only into the dashboard's
-- DATABASE_URL on the hosting side.

create role factory_dashboard login password 'CHANGE_ME';

grant usage on schema public to factory_dashboard;
grant select on all tables in schema public to factory_dashboard;
-- Tables and monthly partitions the factory creates later are readable too.
alter default privileges in schema public grant select on tables to factory_dashboard;
-- The dashboard recomputes the audit chain on every view.
grant execute on function audit_verify() to factory_dashboard;

-- Belt and braces: even a mistaken grant cannot let this role change data.
alter role factory_dashboard set default_transaction_read_only = on;
