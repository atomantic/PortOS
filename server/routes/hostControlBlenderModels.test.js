import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-blender-models-host-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-blender-models-host-') }));
afterAll(cleanupTempDataRoots);

// A Blender model is operator Python that runs with host access, like a film
// (hostControlMusicVideoBlender.test.js). Real router behind the real gates;
// every route that writes the source Blender will run, runs Blender, opens the
// Blender application or changes what is published is a spy, so an
// unauthorized caller that reaches one is visible.
const state = vi.hoisted(() => ({ enabled: false }));
const ID = 'bmodel-00000000-0000-4000-8000-000000000000';
const BUILD = 'build-20260101T000000Z-0000abcd';
const sink = vi.hoisted(() => ({
  createBlenderModel: vi.fn(async () => ({ id: 'bmodel-00000000-0000-4000-8000-000000000000' })),
  renameBlenderModel: vi.fn(async () => ({})),
  deleteBlenderModel: vi.fn(async () => ({ ok: true })),
  scaffoldBlenderModelWorkspace: vi.fn(async () => ({})),
  writeBlenderModelFile: vi.fn(async () => ({ path: 'model.py', bytes: 1 })),
  deleteBlenderModelFile: vi.fn(async () => ({ path: 'model.py' })),
  publishBlenderModelBuild: vi.fn(async () => ({})),
  openBlenderModelBuild: vi.fn(async () => ({ opened: true })),
  startBlenderModelBuild: vi.fn(async () => ({ job: { id: 'bj-example' } })),
  cancelBlenderModelBuild: vi.fn(() => true),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => state.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/blenderModels/models.js', () => ({
  createBlenderModel: sink.createBlenderModel,
  getBlenderModelState: vi.fn(async (id) => ({ id })),
  renameBlenderModel: sink.renameBlenderModel,
  deleteBlenderModel: sink.deleteBlenderModel,
  scaffoldBlenderModelWorkspace: sink.scaffoldBlenderModelWorkspace,
  writeBlenderModelFile: sink.writeBlenderModelFile,
  deleteBlenderModelFile: sink.deleteBlenderModelFile,
  publishBlenderModelBuild: sink.publishBlenderModelBuild,
  openBlenderModelBuild: sink.openBlenderModelBuild,
  requireBlenderModel: vi.fn(async (id) => ({ id })),
}));
vi.mock('../services/blenderModels/build.js', () => ({
  startBlenderModelBuild: sink.startBlenderModelBuild,
  cancelBlenderModelBuild: sink.cancelBlenderModelBuild,
}));

import blenderModelsRoutes from './blenderModels.js';

const MODEL = `/api/blender-models/${ID}`;
const mounts = [['/api/blender-models', blenderModelsRoutes]];
const workflows = [
  ['put', `${MODEL}/file`, { path: 'model.py', content: 'print("example")\n' }, sink.writeBlenderModelFile, 200],
  ['delete', `${MODEL}/file?path=model.py`, undefined, sink.deleteBlenderModelFile, 200],
  ['post', `${MODEL}/workspace`, { template: 'starter' }, sink.scaffoldBlenderModelWorkspace, 201],
  ['post', `${MODEL}/builds`, { quality: 'draft' }, sink.startBlenderModelBuild, 202],
  ['post', `${MODEL}/builds/${BUILD}/open`, {}, sink.openBlenderModelBuild, 200],
  ['post', `${MODEL}/publish`, { buildId: BUILD }, sink.publishBlenderModelBuild, 200],
  // Records and cancellation: nothing here chooses or starts what runs.
  ['post', '/api/blender-models', { name: 'Example model' }, sink.createBlenderModel, 201],
  ['patch', MODEL, { name: 'Renamed example' }, sink.renameBlenderModel, 200],
  ['post', `${MODEL}/builds/${BUILD}/cancel`, {}, sink.cancelBlenderModelBuild, 200],
  ['delete', MODEL, undefined, sink.deleteBlenderModel, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('Blender Models behind the default-deny gate (#17874)', () => {
  it('refuses a remote caller before any route that writes, builds, publishes or launches Blender', async () => {
    for (const workflow of workflows) await expectRemoteRefusal(mounts, workflow);
  });

  it('still runs every model route for a local connection and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth: state, mounts, workflows });
  });
});
