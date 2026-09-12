/**
 * The stitch is where a failed in-place audio mux used to become a USER-VISIBLE
 * data-loss-shaped bug (#7237): `maybeMuxPipelineAudio` is awaited inside
 * `runStitch`'s try, so a throw out of the mux landed in the catch that writes
 * `status: 'failed'` — a successfully rendered and stitched episode was orphaned
 * on disk, never recorded as `finalVideoId`, and never added to its collection,
 * with a raw `EPERM: ... rename` as the user-facing reason.
 *
 * This pins the degradation contract at that boundary: the mux is best-effort,
 * so an install failure must cost the audio overlay and nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-stitchrunner-test-${process.pid}-${Date.now()}`);
const VIDEOS_DIR = join(TEST_HOME, 'videos');

const FINAL_ENTRY = { id: 'render-job-1', filename: 'episode.mp4' };
const EPISODE_BYTES = 'the-stitched-episode';
const MUXED_BYTES = 'the-muxed-episode';

let cdProject;
const updateProjectCalls = [];
const addCollectionItemMock = vi.fn();
let issue;
let ffmpegWritesOutput = false;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return { ...actual, PATHS: { ...actual.PATHS, videos: VIDEOS_DIR } };
});

vi.mock('./local.js', () => ({
  getProject: async () => cdProject,
  updateProject: async (id, patch) => {
    updateProjectCalls.push(patch);
    cdProject = { ...cdProject, ...patch };
  },
}));

vi.mock('./orchestrator.js', () => ({
  buildTimelineClips: () => [{ videoId: 'clip-1' }],
}));

vi.mock('../videoTimeline/local.js', () => ({
  createProject: async () => ({ id: 'timeline-1' }),
  updateProject: async () => {},
  renderProject: async () => ({ jobId: FINAL_ENTRY.id }),
  getProject: async () => null,
  getRenderJobStatus: () => ({ status: 'running' }),
}));

vi.mock('../videoGen/local.js', () => ({ loadHistory: async () => [FINAL_ENTRY] }));
vi.mock('../mediaCollections.js', () => ({ addItem: (...a) => addCollectionItemMock(...a) }));

vi.mock('../pipeline/issues.js', async () => {
  const actual = await vi.importActual('../pipeline/issues.js');
  return { ...actual, getIssue: async () => issue };
});

// The real `installEncodedVideo` and `runFfmpegProcess` are pulled through —
// only the binary lookup and the spawn are faked, so the rollback under test is
// the production one.
vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return { ...actual, findFfmpeg: async () => '/usr/local/bin/ffmpeg' };
});

// The fake ffmpeg exits 0; whether it PRODUCES its output file is the switch
// between the two cases below. Withholding the file makes the in-place install
// the step that fails, which is the shape of the Windows
// `rename`-onto-an-existing-destination failure this guards.
vi.mock('../../lib/childProcess.js', async () => {
  const actual = await vi.importActual('../../lib/childProcess.js');
  return {
    ...actual,
    spawn: (_bin, args) => {
      const listeners = {};
      Promise.resolve().then(async () => {
        if (ffmpegWritesOutput) {
          const fsp = await import('fs/promises');
          await fsp.writeFile(args[args.length - 1], Buffer.from(MUXED_BYTES)).catch(() => {});
        }
        listeners.close?.(0, null);
      });
      return {
        stderr: { on: () => {} },
        on: (event, cb) => { listeners[event] = cb; },
        kill: () => {},
      };
    },
  };
});

const { runStitch } = await import('./stitchRunner.js');

beforeEach(async () => {
  updateProjectCalls.length = 0;
  addCollectionItemMock.mockReset();
  addCollectionItemMock.mockResolvedValue(undefined);
  ffmpegWritesOutput = false;
  cdProject = {
    id: 'cd-1',
    name: 'Ep 1',
    workspace: 'series',
    collectionId: 'coll-1',
    sourceIssueId: 'issue-1',
  };
  // 'silent' with no VO lines is the single-mux path: muxStripAudio and nothing
  // else, so a failure here can only be the in-place install.
  issue = { stages: { audio: { audioMode: 'silent', lines: [] } } };
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  await mkdir(VIDEOS_DIR, { recursive: true });
  await writeFile(join(VIDEOS_DIR, FINAL_ENTRY.filename), Buffer.from(EPISODE_BYTES));
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('runStitch — audio mux is best-effort', () => {
  it('completes the stitch when the in-place audio install fails', async () => {
    await runStitch('cd-1');

    const final = updateProjectCalls.at(-1);
    expect(final).toMatchObject({ finalVideoId: FINAL_ENTRY.id, status: 'complete', failureReason: null });
    // The regression wrote status:'failed' with the raw rename errno.
    expect(updateProjectCalls.some((p) => p.status === 'failed')).toBe(false);
    // The episode still reaches its collection.
    expect(addCollectionItemMock).toHaveBeenCalledWith('coll-1', { kind: 'video', ref: FINAL_ENTRY.id });
    // The rendered episode is intact and nothing was stranded beside it.
    expect(await readFile(join(VIDEOS_DIR, FINAL_ENTRY.filename), 'utf8')).toBe(EPISODE_BYTES);
    expect(await readdir(VIDEOS_DIR)).toEqual([FINAL_ENTRY.filename]);
  });

  it('installs the muxed episode over the original when the mux succeeds', async () => {
    // The same path with the install able to land, so the failure case above is
    // a real branch rather than a mux that never does anything either way.
    ffmpegWritesOutput = true;
    await runStitch('cd-1');

    expect(updateProjectCalls.at(-1)).toMatchObject({ finalVideoId: FINAL_ENTRY.id, status: 'complete' });
    expect(await readFile(join(VIDEOS_DIR, FINAL_ENTRY.filename), 'utf8')).toBe(MUXED_BYTES);
    expect(await readdir(VIDEOS_DIR)).toEqual([FINAL_ENTRY.filename]);
  });
});
