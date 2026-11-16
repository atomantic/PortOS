import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-auxiliary-media-authority-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and hostControlCoverage.test.js.
// The media-jobs router's authorized workflow is in hostControlPreGuardMedia.test.js.
// The retired LoRA dataset router answers 410 for every method and path.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));

const mounts = [['/api/lora-datasets', (await import('./loraDatasets.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('LoRA dataset router behind the default-deny gate (#16114)', () => {
  it('answers 410 LORA_TRAINING_RETIRED for every method and path for a local operator and a delegated agent session', async () => {
    const { createSession } = await import('../services/auth.js');
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const app = await hostControlApp(address, mounts);
      for (const call of [
        ['get', '/api/lora-datasets'],
        ['get', '/api/lora-datasets/example-dataset'],
        ['get', '/api/lora-datasets/example-dataset/caption-runs/example-run/events'],
        ['post', '/api/lora-datasets/example-dataset/caption-runs/example-run/cancel', {}],
        ['delete', '/api/lora-datasets/example-dataset'],
      ]) {
        const response = await callRoute(app, call, headers);
        expect([response.status, response.body.code], call.join(' ')).toEqual([410, 'LORA_TRAINING_RETIRED']);
      }
    }
  });

  it('refuses a remote caller on a password-free install before the tombstone', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/lora-datasets/example-dataset/generate', {}, vi.fn()]);
  });
});
