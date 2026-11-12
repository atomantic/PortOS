import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), enqueue: vi.fn(), get: vi.fn(), attach: vi.fn(), emit: vi.fn() }));
const events = new EventEmitter();
vi.mock('./renderItem.js', () => ({ prepareBoardRenderParams: (...args) => mocks.prepare(...args) }));
vi.mock('./db.js', () => ({ attachBoardPoster: (...args) => mocks.attach(...args) }));
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: (...args) => mocks.emit(...args) }));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: (...args) => mocks.enqueue(...args), getJob: (...args) => mocks.get(...args), mediaJobEvents: events }));
const { completePoster } = await import('./completePoster.js');
beforeEach(() => {
  vi.clearAllMocks();
  events.removeAllListeners();
  mocks.prepare.mockImplementation(async (_render, common) => common);
  mocks.enqueue.mockResolvedValue({ jobId: 'image-1' });
  mocks.get.mockReturnValue({ id: 'image-1', status: 'queued' });
});

it('saves a fast completed render with both prompts and no client callback', async () => {
  const style = { prompt: 'dreamy ink', negativePrompt: 'sharp edges' };
  mocks.get.mockReturnValue({ id: 'image-1', status: 'completed', result: { filename: 'poster.png' } });
  await completePoster('board-1', style, {}, vi.fn());
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ prompt: style.prompt, negativePrompt: style.negativePrompt, width: 1536, height: 1024 }) }));
  expect(mocks.attach).toHaveBeenCalledWith('board-1', style, 'poster.png');
  expect(mocks.emit).toHaveBeenCalledWith('moodBoard', 'board-1');
  expect(events.listenerCount('completed')).toBe(0);
});

it('keeps the old poster on render failure and releases listeners', async () => {
  const result = completePoster('board-1', { prompt: 'ink' }, {}, vi.fn());
  const rejected = expect(result).rejects.toThrow('Renderer stopped');
  await vi.waitFor(() => expect(events.listenerCount('failed')).toBe(1));
  events.emit('failed', { id: 'image-1', status: 'failed', error: 'Renderer stopped' });
  await rejected;
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(events.listenerCount('completed')).toBe(0);
});
