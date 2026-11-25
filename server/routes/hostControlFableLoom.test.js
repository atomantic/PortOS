import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Mount the real router/gates; double effects to prove refusal happens before
// stores, runs or queues are reached, without launching an actual provider.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-fableloom-authority-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/universeBuilder.js', () => ({ getUniverse: vi.fn() }));
vi.mock('../services/fableLoom/index.js', () => ({
  runEpisodeShotAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  applyEpisodeShots: vi.fn(async () => ({ id: 'example-record' })),
  addEpisode: vi.fn(async () => ({ id: 'example-record' })),
  addNode: vi.fn(async () => ({ id: 'example-record' })),
  addNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  branchNode: vi.fn(async () => ({ id: 'example-record' })),
  cancelFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  createLoom: vi.fn(async () => ({ id: 'example-record' })),
  deleteEpisode: vi.fn(async () => ({ id: 'example-record' })),
  deleteLoom: vi.fn(async () => ({ id: 'example-record' })),
  deleteNode: vi.fn(async () => ({ id: 'example-record' })),
  deleteNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  feedbackEpisode: vi.fn(async () => ({ id: 'example-record' })),
  feedbackSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  generateEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  generateSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  getFalVideoAutomation: vi.fn(async () => ({ id: 'example-record' })),
  getFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  getLatestFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  getLoom: vi.fn(async () => ({ id: 'example-record' })),
  listLoomSummaries: vi.fn(async () => []),
  playTurn: vi.fn(async () => ({ id: 'example-record' })),
  publicFableLoomEditorialAutopilot: vi.fn((run) => run),
  reformatEpisodeScenes: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisode: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  reviewFableLoomPlaythroughs: vi.fn(async () => ({ id: 'example-record' })),
  reviewSeriesPlan: vi.fn(async () => ({ id: 'example-record' })),
  reviewSeriesTeleplay: vi.fn(async () => ({ id: 'example-record' })),
  evaluateAndRemediateFableLoom: vi.fn(async () => ({ id: 'example-record' })),
  startFableLoomEditorialAutopilot: vi.fn(async () => ({ id: 'example-record' })),
  updateEpisode: vi.fn(async () => ({ id: 'example-record' })),
  updateLoom: vi.fn(async () => ({ id: 'example-record' })),
  updateNode: vi.fn(async () => ({ id: 'example-record' })),
  updateNodeTransition: vi.fn(async () => ({ id: 'example-record' })),
  validateEpisodeOutline: vi.fn(async () => ({ id: 'example-record' })),
  weaveEpisode: vi.fn(async () => ({ id: 'example-record' })),
  checkHostedSessionReadiness: vi.fn(async () => ({ id: 'example-record' })),
  createHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  getHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  updateHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  endHostedSession: vi.fn(async () => ({ id: 'example-record' })),
  planEpisodeProduction: vi.fn(async () => ({ id: 'example-record' })),
  startEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  startFalVideoAutomation: vi.fn(async () => ({ id: 'example-record' })),
  getEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  getLatestEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  cancelEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  resumeEpisodeProductionBatch: vi.fn(async () => ({ id: 'example-record' })),
  reviewEpisodeContinuity: vi.fn(async () => ({ id: 'example-record' })),
}));

vi.mock('../services/fableLoom/shotRuns.js', () => ({
  startEpisodeShotRun: vi.fn(async () => ({ id: 'example-record' })),
  getEpisodeShotRun: vi.fn(async () => ({ id: 'example-record' })),
  cancelEpisodeShotRun: vi.fn(async () => ({ id: 'example-record' })),
}));
vi.mock('../services/fableLoom/exports.js', () => ({
  startFableLoomExport: vi.fn(async () => ({ jobId: 'example-export' })),
  getFableLoomExportDownload: vi.fn(),
}));
import * as shotRuns from '../services/fableLoom/shotRuns.js';
import * as exports from '../services/fableLoom/exports.js';
import * as fableLoom from '../services/fableLoom/index.js';
import routes from './fableLoom.js';

const base = '/api/fableloom';
const loom = `${base}/example-loom`;
const episode = `${loom}/episodes/example-episode`;
const node = `${episode}/nodes/example-node`;
const picker = { providerId: 'example-cli', model: 'example-model' };
const generation = [
  ['post', `${loom}/export`, {}, exports.startFableLoomExport, 202, 200],
  ['post', `${loom}/plan/generate`, picker, fableLoom.generateSeriesPlan, 200],
  ['post', `${loom}/plan/review`, picker, fableLoom.reviewSeriesPlan, 200],
  ['post', `${loom}/plan/feedback`, { ...picker, feedback: 'Example feedback' }, fableLoom.feedbackSeriesPlan, 200],
  ['post', `${loom}/review-teleplay`, picker, fableLoom.reviewSeriesTeleplay, 200],
  ['post', `${loom}/editorial/remediate`, picker, fableLoom.evaluateAndRemediateFableLoom, 200],
  ['post', `${loom}/playtest`, picker, fableLoom.reviewFableLoomPlaythroughs, 200],
  ['post', `${loom}/editorial/autopilot/start`, picker, fableLoom.startFableLoomEditorialAutopilot, 202, 200],
  ['post', `${episode}/weave`, picker, fableLoom.weaveEpisode, 200],
  ['post', `${episode}/shots/start`, picker, shotRuns.startEpisodeShotRun, 202, 200],
  ['post', `${episode}/outline/generate`, picker, fableLoom.generateEpisodeOutline, 200],
  ['post', `${episode}/outline/review`, picker, fableLoom.reviewEpisodeOutline, 200],
  ['post', `${node}/branch`, picker, fableLoom.branchNode, 200],
  ['post', `${episode}/review`, picker, fableLoom.reviewEpisode, 200],
  ['post', `${episode}/feedback`, { ...picker, feedback: 'Example feedback' }, fableLoom.feedbackEpisode, 200],
  ['post', `${episode}/play`, { ...picker, nodeId: 'example-node', message: 'Example choice' }, fableLoom.playTurn, 200],
  ['post', `${episode}/reformat`, { ...picker, format: 'teleplay' }, fableLoom.reformatEpisodeScenes, 200],
  ['post', `${episode}/production/batch`, { imageMode: 'codex' }, fableLoom.startEpisodeProductionBatch, 201, 200],
  ['post', `${episode}/production/batch/example-run/resume`, {}, fableLoom.resumeEpisodeProductionBatch, 200],
];
const mounts = [[base, routes]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  fableLoom.getEpisodeProductionBatch.mockReturnValue({
    id: 'example-run', loomId: 'example-loom', episodeId: 'example-episode',
  });
});

// Principal matrix: services/authGate.test.js. Kept: the private-download read
// refusal, one remote refusal ahead of the effects, and every route working for
// local and agent callers.
describe('FableLoom agent workflows behind the default-deny gate (#10668, #16114)', () => {
  it('protects private package downloads before reading an artifact', async () => {
    const result = await callRoute(await hostControlApp('192.0.2.10', mounts), ['get', `${loom}/export/example-export/download`]);
    expect([result.status, result.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    expect(exports.getFableLoomExportDownload).not.toHaveBeenCalled();
  });

  it('refuses a remote caller before effects, even for an API-first provider', async () => {
    const [, path, body, effect] = generation[1];
    await expectRemoteRefusal(mounts, ['post', path, { ...body, providerId: 'example-api' }, effect]);
    for (const e of [...Object.values(fableLoom), ...Object.values(shotRuns), ...Object.values(exports)]) expect(e).not.toHaveBeenCalled();
  });

  it('still runs authoring, production, record edits, planning and cancellation for local and agent callers, with reads open remotely', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...generation,
      ['post', base, { name: 'Example Loom' }, fableLoom.createLoom, 201],
      ['patch', loom, { premise: 'Example premise' }, fableLoom.updateLoom, 200],
      ['post', `${loom}/episodes`, { title: 'Example episode' }, fableLoom.addEpisode, 201],
      ['patch', node, { prose: 'Example prose' }, fableLoom.updateNode, 200],
      ['post', `${episode}/outline/validate`, {}, fableLoom.validateEpisodeOutline, 200],
      ['post', `${episode}/shots/cancel`, {}, shotRuns.cancelEpisodeShotRun, 200],
      ['post', `${episode}/production/plan`, {}, fableLoom.planEpisodeProduction, 200],
      ['post', `${episode}/continuity/review`, {}, fableLoom.reviewEpisodeContinuity, 200],
      ['post', `${episode}/production/batch/example-run/cancel`, {}, fableLoom.cancelEpisodeProductionBatch, 200],
    ] });
    expect(fableLoom.weaveEpisode).toHaveBeenLastCalledWith('example-loom', 'example-episode', picker);
    expect(fableLoom.resumeEpisodeProductionBatch).toHaveBeenLastCalledWith('example-run');
    auth.enabled = false;
    const read = await callRoute(await hostControlApp('192.0.2.10', mounts), ['get', `${episode}/shots/status`]);
    expect(read.status).toBe(200);
    expect(shotRuns.getEpisodeShotRun).toHaveBeenCalledTimes(1);
  });
});
