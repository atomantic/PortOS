import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => (
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-jira-authority-') })
));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.unstubAllGlobals());

// Repointing a saved Jira destination would send its stored token elsewhere
// (#11270), and ticket writes act on the saved account. Every Jira write is gated
// by the default-deny policy (#16018), whose refusal and principal matrix live in
// services/authGate.test.js. This suite keeps the authorized workflow against the
// real service: an update keeps the stored token without echoing it, and the
// connection test uses it.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/jiraReports.js', () => ({}));
vi.mock('../services/apps.js', () => ({ getAppById: vi.fn() }));
const jiraService = await import('../services/jira.js');
const mounts = [['/api/jira', (await import('./jira.js')).default]];

const savedDetails = {
  id: 'example', name: 'Example Jira', baseUrl: 'https://jira.private.test',
  email: 'operator@example.test', apiToken: 'synthetic-token',
};
const replacementDetails = {
  id: 'example', name: 'Example Jira', baseUrl: 'https://jira.replacement.test',
  email: 'operator@example.test',
};

// Collects outbound Jira calls; the test harness's own loopback requests pass through.
const installCollector = () => {
  const requests = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    requests.push({ url, authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ displayName: 'Example User', emailAddress: 'operator@example.test' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }));
  return requests;
};

beforeEach(async () => {
  auth.enabled = false;
  await jiraService.saveInstances({ instances: {} });
  await jiraService.upsertInstance('example', savedDetails);
});

describe('Jira router behind the default-deny gate (#16114)', () => {
  it('still repoints and tests a destination with its stored token for a local operator and a delegated agent session', async () => {
    const collected = installCollector();
    const { createSession } = await import('../services/auth.js');
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, REMOTE_ADDRESS, { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const app = await hostControlApp(address, mounts);
      const update = await callRoute(app, ['post', '/api/jira/instances', replacementDetails], headers);
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      expect(update.body).not.toHaveProperty('apiToken');
      const connection = await callRoute(app, ['post', '/api/jira/instances/example/test', {}], headers);
      expect([connection.status, connection.body.success]).toEqual([200, true]);
    }
    expect((await jiraService.getInstances()).instances.example)
      .toMatchObject({ ...replacementDetails, apiToken: 'synthetic-token' });
    const validation = { url: 'https://jira.replacement.test/rest/api/2/myself', authorization: 'Bearer synthetic-token' };
    expect(collected).toEqual([validation, validation]);
  });
});
