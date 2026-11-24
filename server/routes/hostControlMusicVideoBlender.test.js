import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-blender-host-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-blender-host-') }));
afterAll(cleanupTempDataRoots);

// A Blender film is operator Python that runs with host access. Real router
// behind the real gates (principal matrix: services/authGate.test.js); every route that writes the source Blender
// will run, runs Blender or ffmpeg, opens the Blender application or deletes
// rendered frames is a spy, so an unauthorized caller that reaches one is visible.
const state = vi.hoisted(() => ({ enabled: false }));
const sink = vi.hoisted(() => ({
  scaffoldBlenderWorkspace: vi.fn(async () => ({ copied: [] })),
  writeBlenderFile: vi.fn(async () => ({ path: 'film.py', bytes: 1 })),
  deleteBlenderFile: vi.fn(async () => ({ path: 'film.py' })),
  startBlenderSync: vi.fn(async () => ({ job: { id: 'bj-example-sync' } })),
  clearBlenderFrames: vi.fn(async () => ({ freedBytes: 0 })),
  enqueueBlenderRenders: vi.fn(async () => ({ jobs: [], skipped: [] })),
  startBlenderCut: vi.fn(async () => ({ job: { id: 'bj-example' } })),
  openBlenderShot: vi.fn(async () => ({ opened: true })),
}));
const open = vi.hoisted(() => ({
  saveBlenderSettings: vi.fn(async () => ({})),
  saveBlenderShotNote: vi.fn(async () => ({})),
  cancelBlenderProjectJobs: vi.fn(() => true),
}));
const motion = vi.hoisted(() => ({
  saveBlenderMotionReferences: vi.fn(async () => ({})),
  makeBlenderMotionStrip: vi.fn(async () => ({ file: 's010/references/mr-example.jpg' })),
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
vi.mock('../services/musicVideo/requireProject.js', () => ({ requireProject: vi.fn(async (id) => ({ id, scenes: [] })) }));
vi.mock('../services/musicVideo/blender/state.js', async (importOriginal) => ({ ...await importOriginal(), getBlenderState: vi.fn(async () => ({ settings: {} })) }));
vi.mock('../services/film/song.js', async (importOriginal) => ({ ...await importOriginal(), writeBlenderSong: vi.fn(async () => ({})) }));
vi.mock('../services/film/sources.js', async (importOriginal) => ({
  ...await importOriginal(),
  scaffoldBlenderWorkspace: sink.scaffoldBlenderWorkspace, writeBlenderFile: sink.writeBlenderFile, deleteBlenderFile: sink.deleteBlenderFile,
}));
vi.mock('../services/film/sync.js', async (importOriginal) => ({ ...await importOriginal(), startBlenderSync: sink.startBlenderSync }));
vi.mock('../services/film/usage.js', async (importOriginal) => ({ ...await importOriginal(), clearBlenderFrames: sink.clearBlenderFrames }));
vi.mock('../services/film/queue.js', async (importOriginal) => ({
  ...await importOriginal(), enqueueBlenderRenders: sink.enqueueBlenderRenders, cancelBlenderProjectJobs: open.cancelBlenderProjectJobs,
}));
vi.mock('../services/musicVideo/blender/cuts.js', async (importOriginal) => ({ ...await importOriginal(), startBlenderCut: sink.startBlenderCut }));
vi.mock('../services/film/open.js', async (importOriginal) => ({ ...await importOriginal(), openBlenderShot: sink.openBlenderShot }));
vi.mock('../services/film/motionReferences.js', async (importOriginal) => ({ ...await importOriginal(), ...motion }));
vi.mock('../services/film/record.js', async (importOriginal) => ({
  ...await importOriginal(), saveBlenderSettings: open.saveBlenderSettings, saveBlenderShotNote: open.saveBlenderShotNote,
}));

import musicVideoRoutes from './musicVideo.js';

const FILM = '/api/music-video/example-project/blender';
const mounts = [['/api/music-video', musicVideoRoutes]];
const workflows = [
  ['post', `${FILM}/workspace`, { template: 'starter' }, sink.scaffoldBlenderWorkspace, 201],
  ['put', `${FILM}/file`, { path: 'film.py', content: 'print("example")\n' }, sink.writeBlenderFile, 200],
  ['delete', `${FILM}/file?path=film.py`, undefined, sink.deleteBlenderFile, 200],
  ['post', `${FILM}/sync`, {}, sink.startBlenderSync, 202],
  ['post', `${FILM}/frames/clear`, {}, sink.clearBlenderFrames, 200],
  ['post', `${FILM}/render`, { quality: 'preview' }, sink.enqueueBlenderRenders, 202],
  ['post', `${FILM}/cut`, { quality: 'preview' }, sink.startBlenderCut, 202],
  ['post', `${FILM}/shots/s010/open`, {}, sink.openBlenderShot, 200],
  // Records and cancellation: nothing here chooses or starts what runs.
  ['put', `${FILM}/settings`, { fps: 30 }, open.saveBlenderSettings, 200],
  ['put', `${FILM}/shots/s010/note`, { text: 'Example note' }, open.saveBlenderShotNote, 200],
  ['put', `${FILM}/shots/s010/motion-references`, { references: [] }, motion.saveBlenderMotionReferences, 200],
  // Runs ffmpeg on a Media History clip, but nothing the film or the operator authored.
  ['post', `${FILM}/shots/s010/motion-references/mr-example/strip`, {}, motion.makeBlenderMotionStrip, 200],
  ['post', `${FILM}/cancel`, {}, open.cancelBlenderProjectJobs, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('Music Video Blender film behind the default-deny gate (#16114)', () => {
  it('refuses a remote caller before any source write or process', async () => {
    await expectRemoteRefusal(mounts, workflows[1]);
  });

  it('still runs every film route for a local connection and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth: state, mounts, workflows });
  });
});
