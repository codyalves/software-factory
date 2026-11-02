/**
 * Placeholder for M1. Workers will lease queued steps, run each agent or gate
 * step in a fresh sandbox container, heartbeat while it runs, and report
 * results through the step table. Kept as a separate deployable now so it can
 * scale on queue depth independently of the API.
 */
console.info('step runner started; step execution arrives in M1');

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
