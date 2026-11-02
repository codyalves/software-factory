# ADR 0002: GitHub first, behind a forge adapter

Status: accepted (2026-11-02)

## Context

GitHub and GitLab both support agentic workflows. GitLab markets an integrated
"governed software factory"; GitHub offers multi-agent assignment on issues and
the largest developer audience. This project's orchestrator owns the workflow,
so the git host only supplies issues, webhooks, pull requests and CI status.

## Decision

Build on GitHub first. All host-specific behavior sits behind
`IForgeAdapter` and the webhook parser, so a GitLab adapter can be added
without changing the orchestrator.

## Consequences

- The governance layer is visibly this project's work, not a host feature.
- Free GitHub Actions minutes cover CI for frequent gate runs.
- A GitLab adapter is a later milestone and a portability demonstration.
