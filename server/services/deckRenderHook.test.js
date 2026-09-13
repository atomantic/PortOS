import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const attachCardRender = vi.fn(async () => ({ primaryImageRef: 'job-1.png' }));
const markCardRenderTerminal = vi.fn(async () => null);
vi.mock('./decks.js', () => ({ attachCardRender, markCardRenderTerminal }));

const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./deckRenderHook.js');

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const job = (params, { id = 'job-1', filename = 'job-1.png', queuedAt = '2026-01-01T00:00:00.000Z' } = {}) => ({
  id, kind: 'image', params, queuedAt, result: { filename },
});
const tag = { deckId: 'd1', cardId: 'c1', key: 'major-0' };

describe('deckRenderHook', () => {
  beforeEach(() => {
    hook.__testing.reset();
    hook.initDeckRenderHook();
    attachCardRender.mockClear();
    markCardRenderTerminal.mockClear();
  });
  afterEach(() => hook.__testing.reset());

  it('files a completed deckCard-tagged image onto its card and ignores untagged jobs', async () => {
    mediaJobEvents.emit('completed', job({ prompt: 'x' }));
    mediaJobEvents.emit('completed', job({ deckCard: tag }));
    await waitFor(() => attachCardRender.mock.calls.length > 0);
    expect(attachCardRender).toHaveBeenCalledTimes(1);
    expect(attachCardRender).toHaveBeenCalledWith({ deckId: 'd1', cardId: 'c1', filename: 'job-1.png', jobId: 'job-1' });
  });

  it('drops an older render that finishes after a newer one for the same card', async () => {
    mediaJobEvents.emit('completed', job({ deckCard: tag }, { id: 'new', filename: 'new.png', queuedAt: '2026-01-02T00:00:00.000Z' }));
    await waitFor(() => attachCardRender.mock.calls.length === 1);
    mediaJobEvents.emit('completed', job({ deckCard: tag }, { id: 'old', filename: 'old.png', queuedAt: '2026-01-01T00:00:00.000Z' }));
    await tick();
    expect(attachCardRender).toHaveBeenCalledTimes(1);
    expect(attachCardRender.mock.calls[0][0].filename).toBe('new.png');
  });

  it('records a failed or canceled job on the card it was for', async () => {
    mediaJobEvents.emit('failed', { ...job({ deckCard: tag }), error: 'boom' });
    mediaJobEvents.emit('canceled', job({ deckCard: tag }, { id: 'job-2' }));
    await waitFor(() => markCardRenderTerminal.mock.calls.length === 2);
    expect(markCardRenderTerminal).toHaveBeenNthCalledWith(1, 'd1', 'c1', { jobId: 'job-1', status: 'failed', error: 'boom' });
    expect(markCardRenderTerminal).toHaveBeenNthCalledWith(2, 'd1', 'c1', { jobId: 'job-2', status: 'canceled', error: null });
  });

  it('is idempotent across a double init', async () => {
    hook.initDeckRenderHook();
    mediaJobEvents.emit('completed', job({ deckCard: tag }));
    await waitFor(() => attachCardRender.mock.calls.length > 0);
    await tick();
    expect(attachCardRender).toHaveBeenCalledTimes(1);
  });
});
