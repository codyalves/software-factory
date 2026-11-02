import { AuditStore, createDb, FactoryControl, migrate, RunStore, StepQueue } from '@factory/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { db, pool, close } = createDb(config.DATABASE_URL);

const app = buildApp(
  {
    runs: new RunStore(db),
    audit: new AuditStore(db),
    steps: new StepQueue(db),
    control: new FactoryControl(db),
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    adminToken: config.ADMIN_TOKEN,
  },
  { logger: { level: config.LOG_LEVEL } },
);

if (config.MIGRATE_ON_STARTUP) {
  const applied = await migrate(pool, config.MIGRATIONS_DIR);
  app.log.info({ applied }, `applied ${applied.length} migration(s)`);
}

app.addHook('onClose', close);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close();
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
