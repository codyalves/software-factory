import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  MIGRATE_ON_STARTUP: z.stringbool().default(false),
  MIGRATIONS_DIR: z.string().default('db/migrations'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ApiConfig = z.infer<typeof schema>;

/** Fails fast at startup with every missing or invalid setting listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
