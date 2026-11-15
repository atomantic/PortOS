import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-auxiliary-media-authority-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and hostControlCoverage.test.js.
// The media-jobs router's authorized workflow is in hostControlPreGuardMedia.test.js.
// The retired LoRA dataset router keeps only caption cancellation as a write.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  cancelCaption: vi.fn(() => ({ canceled: true, run: { runId: 'example-run', status: 'canceling' } })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/loraDatasets.js', () => ({ listDatasets: vi.fn(async () => []), reconcileRenderingImages: vi.fn() }));
vi.mock('../services/loraDatasetCaption.js', () => ({
  attachCaptionSseClient: vi.fn(), cancelCaptionRun: effects.cancelCaption, getActiveCaptionRun: vi.fn(() => null),
}));

const mounts = [['/api/lora-datasets', (await import('./loraDatasets.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('LoRA dataset router behind the default-deny gate (#16114)', () => {
  it('still cancels a caption run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/lora-datasets/example-dataset/caption-runs/example-run/cancel', {}, effects.cancelCaption, 202],
    ] });
    expect(effects.cancelCaption).toHaveBeenLastCalledWith('example-dataset', 'example-run');
  });
});
