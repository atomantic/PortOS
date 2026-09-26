import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import { errorMiddleware } from '../../lib/errorHandler.js';
import { getAppById } from '../../services/apps.js';
import { addTask, isRunning } from '../../services/cos.js';
import { loadHistory } from '../../services/videoGen/history.js';
import router from './launchVideos.js';

vi.mock('../../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../../services/cos.js', () => ({ addTask: vi.fn(), isRunning: vi.fn() }));
vi.mock('../../services/instanceIdentity.js', () => ({ getInstanceId: async () => 'example-instance' }));
vi.mock('../../services/pipeline/audioMux.js', () => ({ resolveMusicTrackPath: async () => null }));
vi.mock('../../services/videoGen/history.js', () => ({ loadHistory: vi.fn() }));
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
