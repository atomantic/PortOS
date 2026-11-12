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

const { preparePoster, completePoster } = vi.hoisted(() => ({ preparePoster: vi.fn(), completePoster: vi.fn() }));
vi.mock('./completePoster.js', () => ({ preparePoster, completePoster }));

vi.mock('./index.js', () => ({ getBoard, updateBoard, updateBoardItem, backfillGalleryPrompts: backfill }));
vi.mock('../mediaPromptFromMedia.js', () => ({ promptFromMedia }));
vi.mock('../moodBoardCompositeStyle.js', () => ({ composeBoardPrompt }));
vi.mock('../socket.js', () => ({ getIo: () => ({ emit }) }));

import { startAnalyzeJob, getAnalyzeJob, analyzeBoardForCombine } from './analyzeJob.js';

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

    expect(await analyzeBoardForCombine('mb-run', { providerId: 'p1', model: 'm' })).toEqual({ id: 'mb-run', items });
    const job = getAnalyzeJob('mb-run');
    expect(job).toMatchObject({ status: 'done', total: 1, done: 1, failures: 0 });
    expect(promptFromMedia).toHaveBeenCalledTimes(1);
    expect(promptFromMedia).toHaveBeenCalledWith(expect.objectContaining({ filename: 'a.png', providerId: 'p1' }));
    expect(updateBoardItem).toHaveBeenCalledWith('mb-run', 'a', { analysis: expect.objectContaining({ prompt: 'ink' }) });
    expect(updateBoard).toHaveBeenCalledWith('mb-run', { style: { prompt: 'composed' } });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('mood-board:analyze', expect.objectContaining({ boardId: 'mb-run' })));
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


describe('Make complete workflow', () => {
  it('refuses to silently join an analysis-only job when a poster was requested, then permits retry', async () => {
    const board = { id: 'complete-overlap', items: [{ id: 'saved', type: 'image', analysis: { prompt: 'ink' } }] };
    let release;
    backfill.mockReturnValueOnce(new Promise(resolve => { release = () => resolve(board); }));
    getBoard.mockResolvedValue(board);
    completePoster.mockResolvedValue(undefined);
    startAnalyzeJob(board.id, { providerId: 'vision' });
    expect(() => startAnalyzeJob(board.id, { providerId: 'vision', render: { mode: 'local' } })).toThrow(/already running/);
    expect(getAnalyzeJob(board.id)).toMatchObject({ status: 'running', makeComplete: false });
    release();
    await waitTerminal(board.id);
    backfill.mockResolvedValue(board);
    startAnalyzeJob(board.id, { providerId: 'vision', render: { mode: 'local' } });
    expect(await waitTerminal(board.id)).toMatchObject({ status: 'done', makeComplete: true });
    expect(completePoster).toHaveBeenCalledTimes(1);
  });

  it('reuses saved analyses, composes both prompts and completes the main image without a client', async () => {
    const items = [{ id: 'saved', type: 'image', analysis: { prompt: 'soft focus', negativePrompt: 'crisp edges' } }];
    const board = { id: 'complete-saved', items, description: 'Keep creative direction' };
    const style = { prompt: 'dreamy soft focus', negativePrompt: 'crisp edges' };
    backfill.mockResolvedValue(board);
    getBoard.mockResolvedValue(board);
    composeBoardPrompt.mockResolvedValue(style);
    let finish;
    completePoster.mockImplementation((_id, _style, _render, queued) => {
      queued('poster-job');
      return new Promise((resolve) => { finish = resolve; });
    });
    startAnalyzeJob(board.id, { providerId: 'vision', render: { mode: 'local' } });
    await vi.waitFor(() => expect(getAnalyzeJob(board.id)).toMatchObject({ status: 'running', phase: 'rendering', posterJobId: 'poster-job' }));
    expect(promptFromMedia).not.toHaveBeenCalled();
    expect(updateBoard).toHaveBeenCalledWith(board.id, { style });
    expect(completePoster).toHaveBeenCalledWith(board.id, style, { mode: 'local' }, expect.any(Function));
    finish();
    expect(await waitTerminal(board.id)).toMatchObject({ status: 'done', makeComplete: true });
  });

  it('keeps successful analyses but refuses to render an incomplete batch; retry analyzes only remaining pins', async () => {
    const saved = { id: 'saved', type: 'image', mediaKey: 'image:saved.png', analysis: { prompt: 'soft focus' } };
    const pending = { id: 'pending', type: 'image', mediaKey: 'image:pending.png' };
    backfill.mockResolvedValue({ items: [saved, pending] });
    promptFromMedia.mockRejectedValueOnce(new Error('provider unavailable'));
    startAnalyzeJob('complete-retry', { providerId: 'vision', render: {} });
    expect(await waitTerminal('complete-retry')).toMatchObject({ status: 'failed', failures: 1 });
    expect(completePoster).not.toHaveBeenCalled();
    expect(composeBoardPrompt).not.toHaveBeenCalled();
    promptFromMedia.mockResolvedValue({ imagePrompt: 'hazy colors' });
    getBoard.mockResolvedValue({ items: [saved, { ...pending, analysis: { prompt: 'hazy colors' } }] });
    completePoster.mockResolvedValue(undefined);
    startAnalyzeJob('complete-retry', { providerId: 'vision', render: {} });
    expect(await waitTerminal('complete-retry')).toMatchObject({ status: 'done' });
    expect(promptFromMedia.mock.calls.map(([input]) => input.filename)).toEqual(['pending.png', 'pending.png']);
  });

  it('checks renderer availability before any analysis or composition', async () => {
    preparePoster.mockRejectedValueOnce(new Error('Renderer disabled'));
    startAnalyzeJob('complete-disabled', { providerId: 'vision', render: {} });
    expect(await waitTerminal('complete-disabled')).toMatchObject({ status: 'failed', error: 'Renderer disabled' });
    expect(promptFromMedia).not.toHaveBeenCalled();
    expect(composeBoardPrompt).not.toHaveBeenCalled();
  });
});


it('Make complete analyzes gallery captions and original prompts without replacing them or repeating saved analysis', async () => {
  const items = [
    { id: 'captioned', type: 'image', mediaKey: 'image:captioned.png', caption: 'original caption' },
    { id: 'prompted', type: 'image', mediaKey: 'image:prompted.png', prompt: 'original generation prompt' },
    { id: 'saved', type: 'image', mediaKey: 'image:saved.png', analysis: { prompt: 'existing visual analysis' } },
  ];
  const board = { id: 'complete-gallery', items };
  backfill.mockResolvedValue(board);
  promptFromMedia.mockResolvedValue({ imagePrompt: 'visible hazy texture', imageNegativePrompt: 'crisp lines' });
  getBoard.mockResolvedValue({ ...board, items: items.map(item => item.analysis ? item : { ...item, analysis: { prompt: 'visible hazy texture' } }) });
  completePoster.mockResolvedValue(undefined);
  startAnalyzeJob(board.id, { providerId: 'vision', render: { mode: 'local' } });
  expect(await waitTerminal(board.id)).toMatchObject({ status: 'done', total: 2, done: 2 });
  expect(promptFromMedia.mock.calls.map(([input]) => input.filename)).toEqual(['captioned.png', 'prompted.png']);
  expect(updateBoardItem.mock.calls.map(([, id, patch]) => [id, patch])).toEqual([
    ['captioned', { analysis: expect.objectContaining({ prompt: 'visible hazy texture', negativePrompt: 'crisp lines' }) }],
    ['prompted', { analysis: expect.objectContaining({ prompt: 'visible hazy texture', negativePrompt: 'crisp lines' }) }],
  ]);
  expect(composeBoardPrompt).toHaveBeenCalledWith(expect.objectContaining({ board: expect.objectContaining({ items: expect.arrayContaining([
    expect.objectContaining({ caption: 'original caption', analysis: { prompt: 'visible hazy texture' } }),
    expect.objectContaining({ prompt: 'original generation prompt', analysis: { prompt: 'visible hazy texture' } }),
  ]) }) }));
  expect(completePoster).toHaveBeenCalled();
});
