import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-datadog-authority-') })
));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.unstubAllGlobals());

// Repointing a saved Datadog destination would send its stored keys elsewhere
// (#11351). Both writes are gated by the default-deny policy (#16018), whose
// refusal and principal matrix live in services/authGate.test.js. This suite
// keeps the authorized workflow against the real service: an update keeps the
// stored keys without echoing them, and the connection test uses them.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
const datadogService = await import('../services/datadog.js');
const mounts = [['/api/datadog', (await import('./datadog.js')).default]];

const savedDetails = {
  id: 'example', name: 'Example Datadog', site: 'datadog.private.test',
  apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key',
};
const replacementDetails = { id: 'example', name: 'Example Datadog', site: 'datadog.replacement.test' };

// Collects outbound Datadog calls; the test harness's own loopback requests pass through.
const installCollector = () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    requests.push({ url, apiKey: options.headers['DD-API-KEY'], appKey: options.headers['DD-APPLICATION-KEY'] });
    return new Response(JSON.stringify({ valid: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return requests;
};

beforeEach(async () => {
  auth.enabled = false;
  await datadogService.saveInstances({ instances: {} });
  await datadogService.upsertInstance('example', savedDetails);
});

describe('Datadog router behind the default-deny gate (#16114)', () => {
  it('still repoints and tests a destination with its stored keys for a local operator and a delegated agent session', async () => {
    const collected = installCollector();
    const { createSession } = await import('../services/auth.js');
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, REMOTE_ADDRESS, { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const app = await hostControlApp(address, mounts);
      const update = await callRoute(app, ['post', '/api/datadog/instances', replacementDetails], headers);
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      expect(update.body).not.toHaveProperty('apiKey');
      expect(update.body).not.toHaveProperty('appKey');
      expect(update.body).toMatchObject({ hasApiKey: true, hasAppKey: true });
      const connection = await callRoute(app, ['post', '/api/datadog/instances/example/test', {}], headers);
      expect([connection.status, connection.body.success]).toEqual([200, true]);
    }
    expect((await datadogService.getInstances()).instances.example)
      .toMatchObject({ ...replacementDetails, apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' });
    const validation = { url: 'https://datadog.replacement.test/api/v1/validate', apiKey: 'synthetic-api-key', appKey: 'synthetic-app-key' };
    expect(collected).toEqual([validation, validation]);
  });
});
