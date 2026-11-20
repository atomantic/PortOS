import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-writers-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Mount the production router and gates; double effects so refusal cannot
// create records, start a background Polish loop, or reach a provider.
const effects = vi.hoisted(() => ({
  analysis: vi.fn(async () => ({ status: 'succeeded' })),
  polish: vi.fn(() => ({ runId: 'example-run' })),
  continuation: vi.fn(async () => ({ options: [] })),
  bridge: vi.fn(async () => ({ proposal: null })),
  augment: vi.fn(async () => ({ proposals: [] })),
  readWork: vi.fn(async () => ({ body: 'Example draft' })),
  updateWork: vi.fn(async (id, patch) => ({ id, ...patch })),
  cancel: vi.fn(() => true),
  listAnalyses: vi.fn(async () => []),
}));
vi.mock('../services/writersRoom/local.js', () => ({
  getWorkWithBody: effects.readWork, updateWork: effects.updateWork,
}));
vi.mock('../services/writersRoom/evaluator.js', () => ({
  runAnalysis: effects.analysis, listAnalyses: effects.listAnalyses,
}));
vi.mock('../services/writersRoom/polish.js', () => ({ startPolish: effects.polish, cancelPolish: effects.cancel }));
vi.mock('../services/writersRoom/liveDirector.js', () => ({
  suggestContinuation: effects.continuation, suggestCdBridge: effects.bridge,
}));
vi.mock('../services/writersRoom/castAugment.js', () => ({ proposeWorkCharacterAugmentation: effects.augment }));
vi.mock('../services/writersRoom/characters.js', () => ({}));
vi.mock('../services/writersRoom/places.js', () => ({}));
vi.mock('../services/writersRoom/objects.js', () => ({}));
vi.mock('../services/writersRoom/syncedReview.js', () => ({}));
vi.mock('../services/writersRoom/promoteToPipeline.js', () => ({}));
vi.mock('../services/catalog/catalogExtraction.js', () => ({}));

import writersRoomRoutes from './writersRoom.js';
import cosScheduleRoutes from './cosScheduleRoutes.js';
const maintenance = vi.hoisted(() => ({
  updateMaintenanceStep: vi.fn(async (id, stepId, pins) => ({ id, steps: [{ id: stepId, ...pins }] })),
}));
vi.mock('../services/maintenanceRun.js', () => maintenance);
vi.mock('../services/taskSchedule.js', () => ({}));

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal before the provider
// dispatch and the authorized workflow for each Writers Room and maintenance write.
const mounts = [['/api/writers-room', writersRoomRoutes], ['/api/cos', cosScheduleRoutes]];
const work = '/api/writers-room/works/wr-work-example';
const augmentBody = { fields: ['want'], providerId: 'example-cli', model: 'example-model' };
const stagePins = { providerId: 'example-cli', model: 'example-model', effort: 'medium' };
const workflows = [
  ['post', `${work}/analysis`, { kind: 'evaluate' }, effects.analysis, 201],
  ['post', `${work}/polish/start`, { cycles: 1 }, effects.polish, 200],
  ['post', `${work}/live-suggest`, { before: 'Example draft' }, effects.continuation, 200],
  ['post', `${work}/cd-bridge/suggest`, { before: 'Example draft' }, effects.bridge, 200],
  ['post', `${work}/characters/wr-char-example/augment`, augmentBody, effects.augment, 200],
  ['post', `${work}/polish/cancel`, {}, effects.cancel, 200],
  ['patch', work, { title: 'Example title' }, effects.updateWork, 200],
  ['patch', '/api/cos/schedule/maintenance-runs/example-run/steps/example-stage', stagePins, maintenance.updateMaintenanceStep, 200],
];
beforeEach(() => { vi.clearAllMocks(); auth.enabled = false; });

describe('Writers Room and deferred maintenance writes behind the default-deny gate (#16114)', () => {
  it('refuses a remote caller before records or provider dispatch', async () => {
    await expectRemoteRefusal(mounts, ['post', `${work}/analysis`, { kind: 'evaluate' }, effects.analysis]);
    // A pending automatic dispatch must not change either.
    await expectRemoteRefusal(mounts, ['patch', '/api/cos/schedule/maintenance-runs/example-run/steps/example-stage', stagePins, maintenance.updateMaintenanceStep]);
  });

  it('still runs every write for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.augment).toHaveBeenLastCalledWith('wr-work-example', 'wr-char-example', augmentBody);
    expect(maintenance.updateMaintenanceStep).toHaveBeenLastCalledWith('example-run', 'example-stage', stagePins);
  });
});
