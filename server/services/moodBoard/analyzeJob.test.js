import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getBoard, updateBoard, updateBoardItem, backfill, promptFromMedia, composeBoardPrompt, emit } = vi.hoisted(() => ({
  getBoard: vi.fn(),
  updateBoard: vi.fn(async () => ({})),
  updateBoardItem: vi.fn(async (_b, id, patch) => ({ id, ...patch })),
  backfill: vi.fn(),
  promptFromMedia: vi.fn(),
  composeBoardPrompt: vi.fn(async () => ({ prompt: 'composed' })),
  emit: vi.fn(),
}));

vi.mock('./index.js', () => ({ getBoard, updateBoard, updateBoardItem, backfillGalleryPrompts: backfill }));
vi.mock('../mediaPromptFromMedia.js', () => ({ promptFromMedia }));
vi.mock('../moodBoardCompositeStyle.js', () => ({ composeBoardPrompt }));
vi.mock('../socket.js', () => ({ getIo: () => ({ emit }) }));

import { startAnalyzeJob, getAnalyzeJob } from './analyzeJob.js';

const waitTerminal = async (id) => {
  for (let i = 0; i < 100; i += 1) {
    const job = getAnalyzeJob(id);
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
};

beforeEach(() => vi.clearAllMocks());

describe('board analyze job', () => {
  it('analyzes only unprompted pins server-side, then composes the style', async () => {
    const items = [
      { id: 'a', type: 'image', mediaKey: 'image:a.png' },
      { id: 'b', type: 'image', mediaKey: 'image:b.png', analysis: { prompt: 'done already' } },
      { id: 'c', type: 'image', imageUrl: 'https://example.com/x.png' },
    ];
    backfill.mockResolvedValue({ id: 'mb-run', items });
    getBoard.mockResolvedValue({ id: 'mb-run', items });
    promptFromMedia.mockResolvedValue({ imagePrompt: 'ink' });

    const started = startAnalyzeJob('mb-run', { providerId: 'p1', model: 'm' });
    expect(started.status).toBe('running');
    // A second start while running joins the live job instead of double-running.
    expect(startAnalyzeJob('mb-run', { providerId: 'p1' }).startedAt).toBe(started.startedAt);

    const job = await waitTerminal('mb-run');
    expect(job).toMatchObject({ status: 'done', total: 1, done: 1, failures: 0 });
    expect(promptFromMedia).toHaveBeenCalledTimes(1);
    expect(promptFromMedia).toHaveBeenCalledWith(expect.objectContaining({ filename: 'a.png', providerId: 'p1' }));
    expect(updateBoardItem).toHaveBeenCalledWith('mb-run', 'a', { analysis: expect.objectContaining({ prompt: 'ink' }) });
    expect(updateBoard).toHaveBeenCalledWith('mb-run', { style: { prompt: 'composed' } });
    expect(emit).toHaveBeenCalledWith('mood-board:analyze', expect.objectContaining({ boardId: 'mb-run' }));
  });

  it('fails without composing when no pin could be analyzed', async () => {
    const items = [{ id: 'a', type: 'image', mediaKey: 'image:a.png' }];
    backfill.mockResolvedValue({ id: 'mb-fail', items });
    getBoard.mockResolvedValue({ id: 'mb-fail', items });
    promptFromMedia.mockRejectedValue(new Error('vision down'));

    startAnalyzeJob('mb-fail', { providerId: 'p1' });
    const job = await waitTerminal('mb-fail');
    expect(job.status).toBe('failed');
    expect(job.failures).toBe(1);
    expect(composeBoardPrompt).not.toHaveBeenCalled();
  });
});
