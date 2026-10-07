import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = {
  getBoard: vi.fn(),
  claimBoardItemRender: vi.fn(),
  settleBoardItemRender: vi.fn(),
  applyBoardItemRender: vi.fn(),
};
vi.mock('./db.js', () => store);
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn() }));

const { renderBoardItem, __setDepsForTests } = await import('./renderItem.js');
const { mediaJobEvents } = await import('../mediaJobQueue/index.js');
const hook = await import('../moodBoardItemRenderHook.js');

const note = { id: 'n1', type: 'text', text: 'Palette: violet and cyan' };
const board = {
  id: 'mb-1',
  items: [note],
  style: { prompt: 'neon chiaroscuro', negativePrompt: 'text, logos' },
};

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: predicate never became true');
}

describe('renderBoardItem', () => {
  const enqueue = vi.fn();
  const emit = vi.fn();
  const imageParams = vi.fn(async (_settings, route, common) => ({ ...common, mode: route.mode || 'local' }));

  beforeEach(() => {
    vi.clearAllMocks();
    __setDepsForTests({ getSettings: async () => ({}), getJob: async () => null, enqueue, emit, imageParams });
    store.getBoard.mockResolvedValue(board);
    store.claimBoardItemRender.mockImplementation(async () => ({ ...note, render: { status: 'queued', jobId: null } }));
    store.settleBoardItemRender.mockImplementation(async (_b, _i, { jobId, status }) => ({ ...note, render: { status, jobId } }));
  });

  it('queues the note words plus the board look, tagged for the completion hook', async () => {
    enqueue.mockResolvedValueOnce({ jobId: 'job-1' });
    const out = await renderBoardItem('mb-1', 'n1', { mode: 'codex' });
    const { params, kind } = enqueue.mock.calls[0][0];
    expect(kind).toBe('image');
    expect(params.prompt).toContain('Palette: violet and cyan');
    expect(params.prompt).toContain('neon chiaroscuro');
    expect(params).toMatchObject({ negativePrompt: 'text, logos', mode: 'codex', moodBoardRender: { boardId: 'mb-1', itemId: 'n1' } });
    expect(store.settleBoardItemRender).toHaveBeenCalledWith('mb-1', 'n1', { jobId: 'job-1', status: 'queued' });
    expect(out).toMatchObject({ jobId: 'job-1', item: { render: { status: 'queued', jobId: 'job-1' } } });
    expect(emit).toHaveBeenCalledWith({ boardId: 'mb-1', itemId: 'n1', status: 'queued' });
  });

  it('marks the note failed instead of leaving it rendering when the backend refuses', async () => {
    imageParams.mockRejectedValueOnce(new Error('The external image backend cannot render board notes'));
    await expect(renderBoardItem('mb-1', 'n1')).rejects.toThrow('cannot render board notes');
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.settleBoardItemRender).toHaveBeenCalledWith('mb-1', 'n1', expect.objectContaining({ jobId: null, status: 'failed' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'n1', status: 'failed' }));
  });

  it('lets a new render replace one whose job is no longer live', async () => {
    store.getBoard.mockResolvedValueOnce({ ...board, items: [{ ...note, render: { status: 'queued', jobId: 'old' } }] });
    __setDepsForTests({ getJob: async (id) => (id === 'old' ? { status: 'failed' } : null) });
    enqueue.mockResolvedValueOnce({ jobId: 'job-2' });
    await renderBoardItem('mb-1', 'n1');
    expect(store.claimBoardItemRender.mock.calls[0][2].isLive('old')).toBe(false);
    // A job id settled by a concurrent request after the read counts as busy.
    expect(store.claimBoardItemRender.mock.calls[0][2].isLive('concurrent')).toBe(true);
  });
});

describe('moodBoardItemRenderHook', () => {
  const job = (params, extra = {}) => ({
    id: 'job-1', kind: 'image', params, queuedAt: '2026-01-01T00:00:00.000Z', result: { filename: 'job-1.png' }, ...extra,
  });
  const tag = { boardId: 'mb-1', itemId: 'n1' };

  beforeEach(() => {
    vi.clearAllMocks();
    __setDepsForTests({ emit: vi.fn() });
    hook.__testing.reset();
    hook.initMoodBoardItemRenderHook();
  });
  afterEach(() => hook.__testing.reset());

  it('turns the tagged note into its rendered image and ignores other jobs', async () => {
    store.applyBoardItemRender.mockResolvedValueOnce({ id: 'n1', type: 'image', mediaKey: 'image:job-1.png' });
    mediaJobEvents.emit('completed', job({ prompt: 'unrelated' }));
    mediaJobEvents.emit('completed', job({ prompt: 'the prompt', moodBoardRender: tag }));
    await waitFor(() => store.applyBoardItemRender.mock.calls.length > 0);
    expect(store.applyBoardItemRender).toHaveBeenCalledTimes(1);
    expect(store.applyBoardItemRender).toHaveBeenCalledWith('mb-1', 'n1', { jobId: 'job-1', filename: 'job-1.png', prompt: 'the prompt' });
  });

  it('returns the note to text with the reason when the job fails or is canceled', async () => {
    store.settleBoardItemRender.mockResolvedValue({ id: 'n1' });
    mediaJobEvents.emit('failed', job({ moodBoardRender: tag }, { error: 'out of memory' }));
    mediaJobEvents.emit('canceled', job({ moodBoardRender: tag }, { id: 'job-2' }));
    await waitFor(() => store.settleBoardItemRender.mock.calls.length === 2);
    expect(store.settleBoardItemRender).toHaveBeenNthCalledWith(1, 'mb-1', 'n1', { jobId: 'job-1', status: 'failed', error: 'out of memory' });
    expect(store.settleBoardItemRender).toHaveBeenNthCalledWith(2, 'mb-1', 'n1', { jobId: 'job-2', status: 'failed', error: 'The render was canceled' });
  });
});
