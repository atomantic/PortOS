import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-render-') }));
afterAll(cleanupTempDataRoots);

// ffmpeg dispatch routes of the Music Video family (#12514) are plain writes under
// the default-deny gate (#16018), whose principal matrix lives in
// services/authGate.test.js. This suite keeps the router's authorized workflow;
// each ffmpeg sink is a spy.
const auth = vi.hoisted(() => ({ enabled: false }));
const sink = vi.hoisted(() => ({
  renderMusicVideo: vi.fn(async () => ({ jobId: 'render-example' })),
  startExcerptRender: vi.fn(async () => ({ jobId: 'excerpt-example' })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/musicVideo/render.js', async (importOriginal) => ({
  ...await importOriginal(), renderMusicVideo: sink.renderMusicVideo,
}));
vi.mock('../services/musicVideo/requireProject.js', () => ({ requireProject: vi.fn(async (id) => ({ id, scenes: [] })) }));
vi.mock('../services/musicVideo/excerptRender.js', async (importOriginal) => ({
  ...await importOriginal(), startExcerptRender: sink.startExcerptRender,
}));
const mounts = [['/api/music-video', (await import('./musicVideo.js')).default]];
const PROJECT = '/api/music-video/example-project';

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Music Video router behind the default-deny gate (#16114)', () => {
  it('still dispatches a render and an excerpt for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `${PROJECT}/render`, {}, sink.renderMusicVideo, 200],
      ['post', `${PROJECT}/excerpt`, { startSec: 0, endSec: 5 }, sink.startExcerptRender, 200],
    ] });
  });
});
