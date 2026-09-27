import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { PATHS } from '../../lib/fileUtils.js';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { getAppById } from '../../services/apps.js';
import { addTask, isRunning } from '../../services/cos.js';
import { loadHistory } from '../../services/videoGen/history.js';
import { detectMotionSkills } from '../../lib/motionSkills.js';
import router from './launchVideos.js';

vi.mock('../../lib/fileUtils.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-launch-publish-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../../services/cos.js', () => ({ addTask: vi.fn(), isRunning: vi.fn() }));
vi.mock('../../services/instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance' }));
vi.mock('../../services/pipeline/audioMux.js', () => ({ resolveMusicTrackPath: async () => null }));
vi.mock('../../services/videoGen/history.js', () => ({ loadHistory: vi.fn() }));
vi.mock('../../lib/motionSkills.js', () => ({ detectMotionSkills: vi.fn(() => []) }));
const app = express();
app.use(express.json());
app.use('/api/apps', router);
app.use(errorMiddleware);
const submit = body => request(app).post('/api/apps/example/launch-videos').send(body);

beforeEach(() => {
  vi.clearAllMocks();
  getAppById.mockResolvedValue({ id: 'example', repoPath: process.cwd() });
  isRunning.mockReturnValue(true);
  addTask.mockResolvedValue({ id: 'task-example' });
});

describe('user-triggered launch videos', () => {
  it('queues selected options with a stable app identity and a private, local output contract', async () => {
    const response = await submit({ tone: 'deadpan', direction: 'Emphasize the working flow', format: 'vertical', targetDurationSec: 18 });
    expect(response.status).toBe(202);
    const [task, kind] = addTask.mock.calls[0];
    expect(kind).toBe('user');
    expect(task).toMatchObject({ description: 'Make launch video', app: 'example', targetInstanceId: 'example-instance', useWorktree: false, noCodeOutput: true, openPR: false, metadata: { analysisType: 'app-launch-video' } });
    expect(task.prompt).toContain('"tone":"deadpan"');
    expect(task.prompt).toContain('"format":"vertical"');
    expect(task.prompt).toContain('"targetDurationSec":18');
    expect(task.prompt).toContain(`launch-videos/example/${response.body.runId}`);
    expect(task.prompt).toContain('Do not read .env*');
    expect(task.prompt).toContain('"motionStyle":"walkthrough"');
    expect(task.prompt).toContain('"critiqueRounds":2');
    expect(task.prompt).toContain('Proof JSON');
    // Every new run starts with the motion kit already in its composition.
    expect(await readdir(join(PATHS.data, 'launch-videos', 'example', response.body.runId, 'composition'))).toEqual(['portos-motion.js']);
    expect(task.prompt).toContain('Only report success after complete');
    expect(task.provider).toBeUndefined();
    addTask.mockClear();
    await submit({ provider: 'example-provider', model: 'example-model', effort: 'high' });
    const [pinned] = addTask.mock.calls[0];
    expect(pinned).toMatchObject({ provider: 'example-provider', model: 'example-model', effort: 'high' });
    // The agent pin chooses the runner; it is not a creative option in the prompt.
    expect(pinned.prompt).not.toContain('example-provider');
    addTask.mockResolvedValue({ id: 'task-example', duplicate: true });
    const duplicate = await submit({ tone: 'parody' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('LAUNCH_VIDEO_ACTIVE');
  });

  it('queues a two-minute managed-app video with explicit music generation and product context', async () => {
    getAppById.mockResolvedValue({ id: 'example', name: 'Example Product', repoPath: process.cwd(), processes: [{ name: 'example-ui', port: 4321 }], secret: 'never-forward' });
    expect((await submit({ targetDurationSec: 120, generateMusic: true, motionGraphics: true })).status).toBe(202);
    const [task] = addTask.mock.calls[0];
    expect(task.prompt).toContain('"name":"Example Product"');
    expect(task.prompt).toContain('"port":4321');
    expect(task.prompt).toContain('"generateMusic":true');
    expect(task.prompt).toContain('"musicMethod":"agent"');
    expect(task.prompt).toContain('Never require a music engine for the agent method');
    // The legacy boolean still selects the showreel grammar.
    expect(task.prompt).toContain('"motionStyle":"showreel"');
    expect(task.prompt).not.toContain('"motionGraphics"');
    expect(task.prompt).toContain('"targetDurationSec":120');
    expect(task.prompt).toContain('NOT the selected app');
    expect(task.prompt).toContain('/api/music/generate');
    expect(task.prompt).not.toContain('never-forward');
    expect((await submit({ targetDurationSec: 121 })).status).toBe(400);
    expect((await submit({ motionGraphics: 'yes' })).status).toBe(400);
    expect((await submit({ motionStyle: 'slideshow' })).status).toBe(400);
    expect((await submit({ critiqueRounds: 5 })).status).toBe(400);
    expect((await submit({ generateMusic: true, musicTrack: 'example.wav' })).status).toBe(400);
    expect(addTask).toHaveBeenCalledTimes(1);
  });

  it('names only installed motion skills and refuses the option when none are installed', async () => {
    const refused = await submit({ motionSkills: true });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('MOTION_SKILLS_MISSING');
    detectMotionSkills.mockReturnValue([{ id: 'hyperframes', found: ['motion-graphics'] }, { id: 'remotion', found: [] }]);
    expect((await submit({ motionSkills: true, motionStyle: 'ui-morph' })).status).toBe(202);
    const [task] = addTask.mock.calls[0];
    expect(task.prompt).toContain('"motionStyle":"ui-morph"');
    expect(task.prompt).toContain('"motionSkills":true');
    expect(task.prompt).toContain('"installedMotionSkills":["motion-graphics"]');
  });

  it('preserves an explicit service choice and rejects unknown music methods', async () => {
    expect((await submit({ generateMusic: true, musicMethod: 'service' })).status).toBe(202);
    expect(addTask.mock.calls[0][0].prompt).toContain('"musicMethod":"service"');
    expect((await submit({ generateMusic: true, musicMethod: 'unknown' })).status).toBe(400);
  });

  it('refuses invalid options, missing music, and unavailable CoS before queuing', async () => {
    expect((await submit({ targetDurationSec: 4 })).status).toBe(400);
    expect((await submit({ tone: 'unknown' })).status).toBe(400);
    expect((await submit({ effort: 'extreme' })).status).toBe(400);
    expect((await submit({ musicTrack: 'missing.wav' })).status).toBe(400);
    isRunning.mockReturnValue(false);
    expect((await submit({})).status).toBe(409);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('returns a bounded app-only result projection and propagates storage failure', async () => {
    loadHistory.mockResolvedValue([
      { id: 'other', launchVideo: { appId: 'other' } },
      ...Array.from({ length: 52 }, (_, n) => ({ id: `video-${n}`, filename: 'example.mp4', thumbnail: 'example.jpg', createdAt: '2026-01-01T00:00:00.000Z', durationSec: 20, prompt: 'not projected', launchVideo: { appId: 'example', caption: 'A clear plan.' } })),
    ]);
    const response = await request(app).get('/api/apps/example/launch-videos');
    expect(response.status).toBe(200);
    expect(response.body.videos).toHaveLength(50);
    expect(response.body.videos[0]).toEqual({ id: 'video-0', filename: 'example.mp4', thumbnail: 'example.jpg', createdAt: '2026-01-01T00:00:00.000Z', durationSec: 20, caption: 'A clear plan.' });
    loadHistory.mockRejectedValue(new Error('Storage unavailable'));
    expect((await request(app).get('/api/apps/example/launch-videos')).status).toBe(500);
  });
});


describe('README publication admission', () => {
  const publish = body => request(app).post('/api/apps/example/launch-videos/publish').send(body);
  const video = { id: 'take-example', filename: 'composition-example.mp4', launchVideo: { appId: 'example' } };
  beforeEach(async () => {
    await mkdir(join(PATHS.data, 'videos'), { recursive: true });
    await writeFile(join(PATHS.data, 'videos', video.filename), 'synthetic media');
    loadHistory.mockResolvedValue([video]);
  });

  it('queues the selected local take in a reviewed, merging worktree and deduplicates per app', async () => {
    const response = await publish({ videoId: video.id, provider: 'example-provider', model: 'example-model', effort: 'high' });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ taskId: 'task-example', videoId: video.id });
    expect(addTask).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Publish launch video to README', app: 'example', targetInstanceId: 'example-instance',
      useWorktree: true, openPR: true, prCompletion: 'review-then-merge',
      provider: 'example-provider', model: 'example-model', effort: 'high',
      metadata: { analysisType: 'app-launch-video-publish', launchVideoId: video.id },
    }), 'user');
    const { prompt } = addTask.mock.calls[0][0];
    expect(prompt).toContain('composition-example.mp4');
    expect(prompt).toContain('<!-- portos-launch-video:start -->');
    expect(prompt).toContain('Replace an existing marked block in place');
    expect(prompt).toContain('at most 8 MiB');
    expect(prompt).toContain('for mp4 remove docs/assets/launch-video.gif');
    expect(prompt).toContain('for gif remove docs/assets/launch-video.mp4 and docs/assets/launch-video-poster.jpg');
    expect(prompt).toContain('"format":"gif"');
    addTask.mockResolvedValue({ id: 'task-example', duplicate: true });
    expect((await publish({ videoId: video.id })).body.code).toBe('LAUNCH_VIDEO_PUBLISH_ACTIVE');
  });

  it('passes the audio-preserving format and rejects unsupported publishing modes', async () => {
    expect((await publish({ videoId: video.id, format: 'mp4' })).status).toBe(202);
    expect(addTask.mock.calls[0][0].prompt).toContain('"format":"mp4"');
    expect(addTask.mock.calls[0][0].prompt).toContain('AAC audio when the source has audio');
    addTask.mockClear();
    expect((await publish({ videoId: video.id, format: 'youtube' })).status).toBe(400);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('rejects invalid selections, other apps, missing files and symlink escapes without dispatch', async () => {
    expect((await publish({ videoId: '../secret' })).status).toBe(400);
    expect((await publish({ videoId: 'unknown' })).status).toBe(404);
    loadHistory.mockResolvedValue([{ ...video, launchVideo: { appId: 'other' } }]);
    expect((await publish({ videoId: video.id })).status).toBe(404);
    loadHistory.mockResolvedValue([{ ...video, filename: '../secret.mp4' }]);
    expect((await publish({ videoId: video.id })).status).toBe(400);
    loadHistory.mockResolvedValue([{ ...video, filename: 'missing.mp4' }]);
    expect((await publish({ videoId: video.id })).status).toBe(404);
    await writeFile(join(PATHS.data, 'outside.mp4'), 'private');
    await symlink(join(PATHS.data, 'outside.mp4'), join(PATHS.data, 'videos', 'escape.mp4'));
    loadHistory.mockResolvedValue([{ ...video, filename: 'escape.mp4' }]);
    expect((await publish({ videoId: video.id })).status).toBe(400);
    expect(addTask).not.toHaveBeenCalled();
  });

  it('reports missing media when the entire video directory was removed', async () => {
    await rm(join(PATHS.data, 'videos'), { recursive: true, force: true });
    const response = await publish({ videoId: video.id });
    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Launch video file is missing');
    expect(addTask).not.toHaveBeenCalled();
  });

  it('does not dispatch when CoS or the repository is unavailable', async () => {
    isRunning.mockReturnValue(false);
    expect((await publish({ videoId: video.id })).status).toBe(409);
    getAppById.mockResolvedValue({ id: 'example' });
    expect((await publish({ videoId: video.id })).status).toBe(400);
    expect(addTask).not.toHaveBeenCalled();
  });
});


describe('feedback revisions', () => {
  let source;
  const video = { id: 'selected-take', durationSec: 18, width: 1080, height: 1920,
    launchVideo: { appId: 'example', runId: 'source-run', synthesizeMusic: true } };
  beforeEach(async () => {
    source = join(PATHS.data, 'launch-videos/example/source-run/composition');
    await mkdir(join(source, 'assets'), { recursive: true });
    await writeFile(join(source, 'index.html'), '<html>Original composition</html>');
    await writeFile(join(source, 'assets/score.js'), 'const score = [1, 2, 3];');
    await writeFile(join(source, 'plan.md'), 'Original plan');
    await writeFile(join(source, 'caption.txt'), 'Original caption');
    await writeFile(join(source, 'storyboard.json'), JSON.stringify({ posterSec: 5, scenes: [{ durationSec: 18, lines: [{ text: 'Example product', wordCount: 2, holdSec: 2 }] }] }));
    loadHistory.mockResolvedValue([video]);
  });
  it('copies the selected source, inherits timing and music, and pins the revision agent', async () => {
    const response = await submit({ sourceVideoId: video.id, feedback: 'Make the final headline larger', provider: 'example-provider', model: 'example-model' });
    expect(response.status).toBe(202);
    const destination = join(PATHS.data, 'launch-videos/example', response.body.runId, 'composition');
    expect(await readFile(join(destination, 'assets/score.js'), 'utf8')).toBe('const score = [1, 2, 3];');
    await writeFile(join(destination, 'index.html'), 'Revised');
    expect(await readFile(join(source, 'index.html'), 'utf8')).toBe('<html>Original composition</html>');
    const task = addTask.mock.calls[0][0];
    expect(task).toMatchObject({ provider: 'example-provider', model: 'example-model', metadata: { sourceVideoId: video.id } });
    expect(task.prompt).toContain('Make the final headline larger');
    expect(task.prompt).toContain('do not rebuild from scratch');
    expect(task.prompt).toContain('"targetDurationSec":18');
    expect(task.prompt).toContain('"format":"vertical"');
    expect(task.prompt).toContain('"synthesizeMusic":true');
  });
  it('rejects invalid feedback, cross-app selections and missing editable source before dispatch', async () => {
    expect((await submit({ sourceVideoId: video.id, feedback: '  ' })).status).toBe(400);
    expect((await submit({ sourceVideoId: video.id })).status).toBe(400);
    expect((await submit({ feedback: 'Edit' })).status).toBe(400);
    expect((await submit({ sourceVideoId: 'unknown', feedback: 'Edit' })).status).toBe(404);
    loadHistory.mockResolvedValue([{ ...video, launchVideo: { ...video.launchVideo, appId: 'other' } }]);
    expect((await submit({ sourceVideoId: video.id, feedback: 'Edit' })).status).toBe(404);
    loadHistory.mockResolvedValue([video]);
    await rm(source, { recursive: true });
    expect((await submit({ sourceVideoId: video.id, feedback: 'Edit' })).status).toBe(409);
    expect(addTask).not.toHaveBeenCalled();
  });
  it('removes an unused copy when dispatch fails or deduplicates, preserving prior takes', async () => {
    const root = join(PATHS.data, 'launch-videos/example');
    const before = await readdir(root);
    addTask.mockResolvedValueOnce({ duplicate: true });
    expect((await submit({ sourceVideoId: video.id, feedback: 'Edit' })).status).toBe(409);
    expect(await readdir(root)).toEqual(before);
    addTask.mockRejectedValueOnce(new Error('Queue unavailable'));
    expect((await submit({ sourceVideoId: video.id, feedback: 'Edit' })).status).toBe(500);
    expect(await readdir(root)).toEqual(before);
  });
});
