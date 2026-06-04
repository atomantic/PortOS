import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

// Regression for the auth-disable-bypass: a `PUT /api/settings` body
// containing a `secrets` key must NEVER reach the persistence layer.
// Otherwise an authenticated session (or a stolen cookie) could disable
// the auth gate or clobber unrelated secrets without proving knowledge
// of the current password — bypassing the proof check enforced by
// /api/auth/password (POST + DELETE).

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-settings-secrets-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const seedSettings = (settings) => {
  writeFileSync(join(tempRoot, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
};

const readSettingsFile = () => {
  const raw = readFileSync(join(tempRoot, 'settings.json'), 'utf8');
  return JSON.parse(raw);
};

const buildApp = async () => {
  vi.resetModules();
  const { default: settingsRoutes } = await import('./settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  return app;
};

beforeEach(() => {
  seedSettings({});
});

afterAll(() => {
  cleanup();
});

describe('PUT /api/settings — secrets-strip', () => {
  it('drops a `secrets` key from the incoming body', async () => {
    seedSettings({
      timezone: 'UTC',
      secrets: { auth: { enabled: true, passwordHash: 'preserved-hash', salt: 'preserved-salt' } },
    });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/settings')
      .send({ timezone: 'America/Los_Angeles', secrets: { auth: { enabled: false } } });
    expect(res.status).toBe(200);
    // Server-side: the auth slice is unchanged.
    const persisted = readSettingsFile();
    expect(persisted.timezone).toBe('America/Los_Angeles');
    expect(persisted.secrets?.auth?.enabled).toBe(true);
    expect(persisted.secrets?.auth?.passwordHash).toBe('preserved-hash');
    expect(persisted.secrets?.auth?.salt).toBe('preserved-salt');
    // Client-side: response never echoes secrets back either.
    expect(res.body.secrets).toBeUndefined();
  });

  it('drops an empty `secrets: {}` (which would otherwise wipe nested secrets via shallow merge)', async () => {
    seedSettings({
      secrets: { auth: { enabled: true, passwordHash: 'h', salt: 's' }, telegram: { token: 't' } },
    });
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'UTC', secrets: {} });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.secrets?.auth?.enabled).toBe(true);
    expect(persisted.secrets?.telegram?.token).toBe('t');
  });

  it('continues to write other top-level keys normally', async () => {
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'Europe/Berlin' });
    expect(res.status).toBe(200);
    expect(readSettingsFile().timezone).toBe('Europe/Berlin');
  });
});
