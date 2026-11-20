import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-story-world-authority-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted router still runs behind the real gates for a
// local operator and a delegated agent session. Each effect is doubled at its
// service boundary, so an admitted request is a call on it.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  continuousVideo: vi.fn(async () => ({})),
  falVideo: vi.fn(async () => ({ jobId: 'example-job' })),
  saveSettings: vi.fn(),
  cdSend: vi.fn(async () => ({ project: { id: 'example-project' } })),
  depart: vi.fn(async () => ({ url: 'https://example.com/visit' })),
  arm: vi.fn(async () => ({ outcome: 'updated', install: { id: 'example-beacon' } })),
}));
const settings = vi.hoisted(() => ({
  pipelineEditorialChecks: { customChecks: [{
    id: 'custom.example-check', label: 'Example check', prompt: 'Flag example problems',
    scope: 'issue', category: 'custom', severityDefault: 'medium',
  }] },
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => settings),
  updateSettingsWith: effects.saveSettings,
}));
vi.mock('../services/videoGen/continuousVideo.js', () => ({
  generateContinuousVideoEpisode: effects.continuousVideo,
  resolveEpisodeContinuity: vi.fn(async () => null),
  composeEpisodeClips: vi.fn(() => [{ prompt: 'Example clip' }]),
  attachEpisodeSseClient: vi.fn(() => false),
  CONTINUOUS_VIDEO_BACKENDS: ['local', 'reactor', 'fal'],
}));
vi.mock('../lib/videoPromptLinter.js', () => ({ lintClips: vi.fn(() => ({ pass: true })) }));
vi.mock('../services/fableLoom/index.js', () => ({ startFalVideoAutomation: effects.falVideo }));
vi.mock('../services/writersRoom/liveDirector.js', () => ({ sendToCreativeDirector: effects.cdSend }));
vi.mock('../services/writersRoom/local.js', () => ({}));
vi.mock('../services/writersRoom/evaluator.js', () => ({}));
vi.mock('../services/writersRoom/polish.js', () => ({}));
vi.mock('../services/writersRoom/syncedReview.js', () => ({}));
vi.mock('../services/writersRoom/characters.js', () => ({}));
vi.mock('../services/writersRoom/castAugment.js', () => ({}));
vi.mock('../services/writersRoom/places.js', () => ({}));
vi.mock('../services/writersRoom/objects.js', () => ({}));
vi.mock('../services/writersRoom/promoteToPipeline.js', () => ({}));
vi.mock('../services/catalog/catalogExtraction.js', () => ({}));
vi.mock('../services/eidoverseTravel.js', () => ({ visitEidoversePeer: effects.depart }));
vi.mock('../services/eidoverseWorld.js', () => ({}));
vi.mock('../services/eidoverseControllerRuntime.js', () => ({
  setEidoverseControllerArmed: effects.arm, summarizeControllerInstall: vi.fn((install) => install),
}));
vi.mock('../services/eidoverseFoundationLedger.js', () => ({}));
vi.mock('../services/eidoverseControllerRegistry.js', () => ({}));


// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', '/api/continuous-video', {
    scenes: [{ lines: [{ type: 'action', text: 'Example action at dusk.' }] }], bible: {},
  }, effects.continuousVideo, 200],
  ['post', '/api/fableloom/example-loom/episodes/example-episode/nodes/example-node/fal-video',
    { prompt: 'Example scene direction, slow push-in.' }, effects.falVideo, 202],
  ['post', '/api/pipeline/editorial/custom-checks', { label: 'Example check', prompt: 'Flag example problems' }, effects.saveSettings, 201],
  ['post', '/api/writers-room/works/wr-work-example/cd-bridge/send', { proposal: {
    logline: 'Example logline', synopsis: 'Example synopsis.',
    scenes: [{ intent: 'Open on the harbor', prompt: 'Wide shot of an example harbor at dawn', durationSeconds: 5 }],
  } }, effects.cdSend, 201],
  ['post', '/api/eidoverse/travel/depart', { peerId: 'example-peer' }, effects.depart, 200],
  ['patch', '/api/eidoverse/world/controllers/example-beacon', { armed: true }, effects.arm, 200],
];

const mounts = [
  ['/api/continuous-video', (await import('./continuousVideoEpisode.js')).default],
  ['/api/fableloom', (await import('./fableLoom.js')).default],
  ['/api/pipeline', (await import('./pipeline/editorial.js')).default],
  ['/api/writers-room', (await import('./writersRoom.js')).default],
  ['/api/eidoverse/travel', (await import('./eidoverseTravelRoutes.js')).default],
  ['/api/eidoverse/world', (await import('./eidoverseWorldRoutes.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.saveSettings.mockImplementation(async (mutate) => mutate(settings));
});

describe('story, video and Eidoverse routers behind the default-deny gate (#16114)', () => {
  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.depart).toHaveBeenLastCalledWith({ peerId: 'example-peer', agent: false });
    expect(effects.arm).toHaveBeenLastCalledWith('example-beacon', true);
  });
});
