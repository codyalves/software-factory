# ADR 0001: Deterministic orchestrator, models only at branch points

Status: accepted (2026-11-02)

## Context

An LLM can drive an agent loop end to end, choosing the next action itself.
That is flexible but hard to audit, hard to reproduce, and prone to compounding
errors over long runs. Decision models such as Jev are fast and return
calibrated probabilities, but published benchmarks show their local advantage
erodes in long-horizon, multi-step systems.

## Decision

The run lifecycle is a state machine in code. Models answer bounded questions
at branch points (issue type, risk tier, failure class, merge policy) through
`DecisionModel`, and generate artifacts inside steps. They never pick the next
state themselves.

## Consequences

- Every transition is explicit, testable and recorded with its inputs.
- Low-confidence decisions take a predefined safe fallback.
- New behavior means a code change to the state machine, which is reviewed
  like any other change.
