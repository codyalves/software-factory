import type { StepHandler } from './step-runner.ts';

/**
 * Step handlers by kind. A worker only claims kinds listed here. Triage
 * arrives in the next M1 change; implement and gate steps follow.
 */
export const handlers: Readonly<Record<string, StepHandler>> = {};
