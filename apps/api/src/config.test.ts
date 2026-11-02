import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/factory', GITHUB_WEBHOOK_SECRET: 's' };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);

    expect(config).toMatchObject({ PORT: 8080, MIGRATE_ON_STARTUP: false });
    expect(config.ADMIN_TOKEN).toBeUndefined();
  });

  it('treats an empty admin token as unset', () => {
    expect(loadConfig({ ...base, ADMIN_TOKEN: '' }).ADMIN_TOKEN).toBeUndefined();
  });

  it('rejects a short admin token', () => {
    expect(() => loadConfig({ ...base, ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
  });

  it('lists every missing setting at once', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*GITHUB_WEBHOOK_SECRET/);
  });
});
