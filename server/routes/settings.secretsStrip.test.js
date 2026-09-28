import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
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

// Seed settings.json through the shared helper so the getSettings() read cache
// is dropped on every seed — see server/lib/settingsTestUtil.js. This suite
// passes today only because buildApp()'s vi.resetModules() incidentally discards
// the cache AFTER this write; routing through the helper makes the invalidation
// an explicit invariant so a future warm-then-direct-write can't regress silently.
const { writeSettingsFile } = bindSettingsFile(tempRoot);

const seedSettings = (settings) => writeSettingsFile(settings);

const readPrivateKeys = () => JSON.parse(readFileSync(join(tempRoot, 'private/api-keys.json'), 'utf8')).keys;

const readSettingsFile = () => {
  const raw = readFileSync(join(tempRoot, 'settings.json'), 'utf8');
  return JSON.parse(raw);
};

// Pay `./settings.js`'s cold transform+import at FILE SCOPE, before any test is
// registered (#7951). `buildApp()` calls `vi.resetModules()` so every test gets
// a fresh module instance, but only the FIRST load in the worker pays vitest's
// transform pipeline for the whole graph — measured under a full-suite run at
// 28.2s for that first import and 530-970ms for each reset-and-reimport after
// it. Charged against the 10s `testTimeout`, the first test in the file failed
// with "Test timed out in 10000ms" while asserting nothing slow; module
// collection is not budgeted, so warming it here leaves every test paying only
// the sub-second re-import. This module instance is intentionally discarded by
// the `vi.resetModules()` below — it exists for the transform cache alone.
// Guarded by `lib/importScoping.test.js`.
await import('./settings.js');

const buildApp = async () => {
  vi.resetModules();
  const { default: settingsRoutes } = await import('./settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  return app;
};

beforeEach(async () => {
  rmSync(join(tempRoot, 'private'), { recursive: true, force: true });
  await seedSettings({});
});

afterAll(() => {
  cleanup();
});

describe('PUT /api/settings — secrets-strip', () => {
  it('drops a `secrets` key from the incoming body', async () => {
    await seedSettings({
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
    await seedSettings({
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

// Regression for #1821: third-party API tokens stored OUTSIDE the `secrets.*`
// hierarchy (`imageGen.hfToken`, `civitai.apiKey`) must never be echoed by
// GET /api/settings. The Settings UI reads only their presence from dedicated
// status routes, so stripping the raw values is non-breaking.
describe('GET /api/settings — external token redaction', () => {
  it('omits imageGen.hfToken and civitai.apiKey while preserving siblings', async () => {
    await seedSettings({
      timezone: 'UTC',
      imageGen: { hfToken: 'hf_secret123', defaultModel: 'flux' },
      civitai: { apiKey: 'civ_secret456', autoDownload: true },
    });
    const app = await buildApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    // Tokens are stripped from the response...
    expect(res.body.imageGen?.hfToken).toBeUndefined();
    expect(res.body.civitai?.apiKey).toBeUndefined();
    // ...but their sibling config is preserved.
    expect(res.body.imageGen?.defaultModel).toBe('flux');
    expect(res.body.civitai?.autoDownload).toBe(true);
    // ...and the on-disk values are untouched (redaction is response-only).
    const persisted = readSettingsFile();
    expect(persisted.imageGen?.hfToken).toBe('hf_secret123');
    expect(persisted.civitai?.apiKey).toBe('civ_secret456');
  });

  it('leaves settings without those keys unchanged', async () => {
    await seedSettings({ timezone: 'UTC', imageGen: { defaultModel: 'flux' } });
    const app = await buildApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.imageGen?.defaultModel).toBe('flux');
    expect(res.body.civitai).toBeUndefined();
  });

  it('does not spread a malformed array-valued civitai into index keys', async () => {
    await seedSettings({ civitai: ['legacy-junk'] });
    const app = await buildApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.civitai)).toBe(true);
    expect(res.body.civitai[0]).toBe('legacy-junk');
  });

  it('also redacts the tokens from the PUT /api/settings save response', async () => {
    // Tokens already persisted; an unrelated save must not echo them back —
    // otherwise the leak just moves from initial load to the save round-trip.
    await seedSettings({
      imageGen: { hfToken: 'hf_secret123', defaultModel: 'flux' },
      civitai: { apiKey: 'civ_secret456' },
    });
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.imageGen?.hfToken).toBeUndefined();
    expect(res.body.civitai?.apiKey).toBeUndefined();
    expect(res.body.imageGen?.defaultModel).toBe('flux');
    // On-disk values survive the redaction.
    const persisted = readSettingsFile();
    expect(persisted.imageGen?.hfToken).toBeUndefined();
    expect(readPrivateKeys().huggingface).toBe('hf_secret123');
    expect(persisted.civitai?.apiKey).toBeUndefined();
    expect(readPrivateKeys().civitai).toBe('civ_secret456');
  });

  // Because GET no longer returns the tokens, a client that rebuilds a full
  // top-level object from a GET and PUTs it back (e.g. patchSettingsSlice)
  // sends an `imageGen`/`civitai` object WITHOUT the token. The server must
  // re-inject the persisted token so an unrelated slice save doesn't silently
  // delete the credential.
  it('preserves a persisted hfToken when a PUT replaces imageGen without it', async () => {
    await seedSettings({ imageGen: { hfToken: 'hf_keepme', mode: 'local' } });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/settings')
      .send({ imageGen: { mode: 'external', local: { pythonPath: '/usr/bin/python3' } } });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.imageGen?.hfToken).toBeUndefined();
    expect(readPrivateKeys().huggingface).toBe('hf_keepme');
    expect(persisted.imageGen?.mode).toBe('external');
    expect(persisted.imageGen?.local?.pythonPath).toBe('/usr/bin/python3');
    // And the save response still doesn't echo the preserved token.
    expect(res.body.imageGen?.hfToken).toBeUndefined();
  });

  it('preserves a persisted civitai.apiKey when a PUT replaces civitai without it', async () => {
    await seedSettings({ civitai: { apiKey: 'civ_keepme', autoDownload: true } });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/settings')
      .send({ civitai: { autoDownload: false } });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.civitai?.apiKey).toBeUndefined();
    expect(readPrivateKeys().civitai).toBe('civ_keepme');
    expect(persisted.civitai?.autoDownload).toBe(false);
  });

  it('leaves a persisted token untouched when the PUT omits its parent entirely', async () => {
    await seedSettings({ imageGen: { hfToken: 'hf_keepme' }, timezone: 'UTC' });
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'America/Los_Angeles' });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.imageGen?.hfToken).toBeUndefined();
    expect(readPrivateKeys().huggingface).toBe('hf_keepme');
    expect(persisted.timezone).toBe('America/Los_Angeles');
  });
});

// Regression for #8997: `videoGen.fal.apiKey` / `videoGen.reactor.apiKey` are
// nested one level deeper than the #1821 tokens above (`videoGen.<provider>.
// apiKey` rather than `<parent>.apiKey`), and `hydratePrivateKeys` re-injects
// them into `settings.videoGen` on every read. The Settings UI reads only
// presence from GET /api/settings/credentials and writes through the
// write-only PUT /api/settings/credentials/:id setter.
describe('GET /api/settings — videoGen fal/reactor token redaction (#8997)', () => {
  it('omits videoGen.fal.apiKey and videoGen.reactor.apiKey while preserving siblings', async () => {
    await seedSettings({
      videoGen: {
        fal: { apiKey: 'fal_secret123', model: 'kling' },
        reactor: { apiKey: 'reactor_secret456', enabled: true },
      },
    });
    const app = await buildApp();
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.videoGen?.fal?.apiKey).toBeUndefined();
    expect(res.body.videoGen?.reactor?.apiKey).toBeUndefined();
    expect(res.body.videoGen?.fal?.model).toBe('kling');
    expect(res.body.videoGen?.reactor?.enabled).toBe(true);
    // Redaction is response-only.
    const persisted = readSettingsFile();
    expect(persisted.videoGen?.fal?.apiKey).toBe('fal_secret123');
    expect(persisted.videoGen?.reactor?.apiKey).toBe('reactor_secret456');
  });

  it('also redacts the fal/reactor keys from the PUT /api/settings save response', async () => {
    await seedSettings({
      videoGen: { fal: { apiKey: 'fal_secret123' }, reactor: { apiKey: 'reactor_secret456' } },
    });
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'UTC' });
    expect(res.status).toBe(200);
    expect(res.body.videoGen?.fal?.apiKey).toBeUndefined();
    expect(res.body.videoGen?.reactor?.apiKey).toBeUndefined();
    // On-disk values move into the private key store, same as hfToken/civitai.
    const persisted = readSettingsFile();
    expect(persisted.videoGen?.fal?.apiKey).toBeUndefined();
    expect(readPrivateKeys().fal).toBe('fal_secret123');
    expect(persisted.videoGen?.reactor?.apiKey).toBeUndefined();
    expect(readPrivateKeys().reactor).toBe('reactor_secret456');
  });

  it('preserves a persisted fal.apiKey when a PUT replaces videoGen.fal without it', async () => {
    await seedSettings({ videoGen: { fal: { apiKey: 'fal_keepme', model: 'kling' } } });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/settings')
      .send({ videoGen: { fal: { model: 'veo' } } });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.videoGen?.fal?.apiKey).toBeUndefined();
    expect(readPrivateKeys().fal).toBe('fal_keepme');
    expect(persisted.videoGen?.fal?.model).toBe('veo');
    expect(res.body.videoGen?.fal?.apiKey).toBeUndefined();
  });

  it('preserves a persisted reactor.apiKey when a PUT replaces videoGen.reactor without it', async () => {
    await seedSettings({ videoGen: { reactor: { apiKey: 'reactor_keepme', enabled: true } } });
    const app = await buildApp();
    const res = await request(app)
      .put('/api/settings')
      .send({ videoGen: { reactor: { enabled: false } } });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.videoGen?.reactor?.apiKey).toBeUndefined();
    expect(readPrivateKeys().reactor).toBe('reactor_keepme');
    expect(persisted.videoGen?.reactor?.enabled).toBe(false);
  });

  it('leaves a persisted fal.apiKey untouched when the PUT omits videoGen entirely', async () => {
    await seedSettings({ videoGen: { fal: { apiKey: 'fal_keepme' } }, timezone: 'UTC' });
    const app = await buildApp();
    const res = await request(app).put('/api/settings').send({ timezone: 'America/Los_Angeles' });
    expect(res.status).toBe(200);
    const persisted = readSettingsFile();
    expect(persisted.videoGen?.fal?.apiKey).toBeUndefined();
    expect(readPrivateKeys().fal).toBe('fal_keepme');
    expect(persisted.timezone).toBe('America/Los_Angeles');
  });
});
