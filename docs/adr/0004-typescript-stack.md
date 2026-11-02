# ADR 0004: TypeScript across the factory

Status: accepted (2026-11-02). Supersedes the .NET 10 implementation of M0.

## Context

M0 was first built in C# on .NET 10, the author's strongest stack. Before M1,
two facts outweighed that:

- The factory's main job is driving coding agents, and agent SDKs and MCP
  tooling are TypeScript-first.
- The target app is a website with a chatbot, naturally built in Next.js.
  One language end to end means shared types between the factory, its
  dashboard and the product it builds.

Switching was cheap at this point because the hard design lives in SQL: the
schema, the append-only rules and the audit hash all sit in
`db/migrations/0001_init.sql` and carried over unchanged.

## Decision

- TypeScript in strict mode, run directly by Node 26 LTS using type stripping.
  `tsc` only type-checks; there is no build step.
- Fastify for HTTP, Kysely on `pg` for queries, Zod for config and input
  validation, Vitest for tests, Biome for lint and format, pnpm workspaces.
- React for the dashboard (M2) and Next.js for the target app.

## Consequences

- The C# test suite became the specification for the port. The same hash
  vectors pin the TypeScript verifier to the Postgres one.
- Type stripping only allows erasable syntax: no enums, namespaces or
  parameter properties. Unions and `as const` objects replace enums.
- JavaScript dates hold milliseconds while the audit chain hashes
  microseconds, so audit timestamps are read from Postgres as text and never
  pass through a `Date`.
