/** A no-song owner drives the public engine workflow without a Music Video record. */
import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { createFakeBlender, exampleManifest } from '../musicVideo/blender/__blenderFixture.js';
import { scaffoldBlenderWorkspace } from './sources.js';
import { startBlenderSync } from './sync.js';
import { enqueueBlenderRenders, resumePendingBlenderRenders } from './queue.js';
import { startBlenderCut } from './cuts.js';
import { getBlenderState } from './state.js';
import { listBlenderJobs, __resetBlenderJobsForTests } from './jobs.js';

function ROOT() { return lazyTempDataRoot('film-owner-test-'); }
const runtime = vi.hoisted(() => ({ blender: null, ffmpeg: [] }));
vi.mock('../../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => runtime.blender.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => runtime.blender.resolveBlenderTool(...args),
}));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(), findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'), bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    runtime.ffmpeg.push(args);
    writeFileSync(args.at(-1), 'video');
    return { ok: true };
  }),
}));
afterAll(() => { __resetBlenderJobsForTests(); cleanupTempDataRoots(); });

it('syncs against an independent timeline, renders stills, resumes old batch intent and joins a silent cut', async () => {
  runtime.blender = createFakeBlender();
  runtime.blender.control.manifest = exampleManifest();
  let record = normalizeBlenderRecord({});
  let durationSec = 6;
  const events = [];
  const owner = {
    kind: 'standalone-test', id: 'example-film', workspaceDir: join(ROOT(), 'standalone', 'example-film'),
    timeline: async () => ({ durationSec, fps: record.settings.fps }),
    song: async () => null,
    readRecord: async () => record,
    writeRecord: async (change) => { record = { ...record, ...change(record) }; return record; },
    emit: (event) => events.push(event),
  };
  const settled = (ids) => vi.waitFor(() => {
    const jobs = listBlenderJobs({ ...owner }).filter((job) => ids.includes(job.id));
    expect(jobs).toHaveLength(ids.length);
    expect(jobs.every((job) => job.status === 'done')).toBe(true);
  }, { timeout: 20_000, interval: 20 });
  await scaffoldBlenderWorkspace(owner);
  for (const shot of runtime.blender.control.manifest.shots) {
    writeFileSync(join(owner.workspaceDir, 'src', 'shots', `${shot.id}.py`), '# example shot');
  }
  await settled([(await startBlenderSync(owner)).job.id]);
  const song = JSON.parse(readFileSync(join(owner.workspaceDir, 'song.json')));
  expect(song).toMatchObject({ durationSec: 6, audio: { master: null, vocalStem: null }, analysis: { beats: [], sections: [], bpm: null }, lyrics: { cues: [], markers: [] } });
  expect((await getBlenderState(owner)).manifest.problems).toEqual([]);
  durationSec = 7;
  expect((await getBlenderState(owner)).manifest.problems.length).toBeGreaterThan(0);
  durationSec = 6;
  await settled((await enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s010'], times: [1] })).jobs.map((job) => job.id));
  expect((await getBlenderState(owner)).renders.s010.stills).toHaveLength(1);
  // Exact pre-extraction on-disk shape: no owner metadata or migration required.
  const pending = join(owner.workspaceDir, 'renders', 'pending.json');
  mkdirSync(join(owner.workspaceDir, 'renders'), { recursive: true });
  writeFileSync(pending, JSON.stringify([{ quality: 'preview', shotIds: ['s010', 's020', 's030'], attempt: 0 }]));
  await resumePendingBlenderRenders([{ ...owner }], 2);
  await settled(listBlenderJobs(owner).filter((job) => job.quality === 'preview').map((job) => job.id));
  expect(existsSync(pending)).toBe(false);
  await settled([(await startBlenderCut(owner, { quality: 'preview' })).job.id]);
  const state = await getBlenderState(owner);
  expect(state.cuts[0]).toMatchObject({ durationSec: 6, missing: [], stale: [], filmLook: false });
  expect(runtime.ffmpeg.at(-1)).toContain('-an');
  expect(events.some((event) => event.kind === 'state')).toBe(true);
  expect(listBlenderJobs({ ...owner, kind: 'another-domain' })).toEqual([]);
});
