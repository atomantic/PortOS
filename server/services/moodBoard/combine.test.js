import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ getBoard: vi.fn(), createCompositeBoard: vi.fn() }));
vi.mock('./localize.js', () => ({ localizeImageUrl: vi.fn() }));
vi.mock('./analyzeJob.js', () => ({ analyzeBoardForCombine: vi.fn() }));
vi.mock('../moodBoardCompositeStyle.js', () => ({ composeBoardPrompt: vi.fn() }));
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: vi.fn(), emitRecordDeleted: vi.fn(), autoSubscribeRecordToAllPeers: vi.fn(async () => {}),
}));
import * as store from './db.js';
import { analyzeBoardForCombine } from './analyzeJob.js';
import { composeBoardPrompt } from '../moodBoardCompositeStyle.js';
import { combineBoards } from './index.js';

const input = { name: 'Blend', boardIds: ['a', 'b'], providerId: 'vision', model: 'chosen', effort: 'high' };
const first = { id: 'a', name: 'Ink', style: { prompt: 'Ink washes' }, items: [] };
const second = { id: 'b', name: 'Neon', style: { prompt: 'Neon lights' }, items: [] };
beforeEach(() => {
  vi.clearAllMocks();
  store.getBoard.mockImplementation(async id => id === 'a' ? first : second);
  composeBoardPrompt.mockResolvedValue({ prompt: 'Luminous ink washes' });
  store.createCompositeBoard.mockResolvedValue({ id: 'new', items: [], style: { prompt: 'Luminous ink washes' } });
});

describe('combine mood boards workflow', () => {
  it('synthesizes saved styles without analyzing or copying source pins', async () => {
    expect(await combineBoards(input)).toMatchObject({ id: 'new', items: [] });
    expect(analyzeBoardForCombine).not.toHaveBeenCalled();
    expect(composeBoardPrompt).toHaveBeenCalledWith({ ...input, sourceBoards: [first, second] });
    expect(store.createCompositeBoard).toHaveBeenCalledWith({ ...input, style: { prompt: 'Luminous ink washes' } }, [first, second]);
  });

  it('requires explicit analysis consent, then analyzes only the missing board before synthesizing', async () => {
    store.getBoard.mockImplementation(async id => id === 'a' ? first : { ...second, style: undefined });
    await expect(combineBoards(input)).rejects.toMatchObject({ code: 'SOURCE_STYLE_REQUIRED' });
    expect(analyzeBoardForCombine).not.toHaveBeenCalled();
    expect(composeBoardPrompt).not.toHaveBeenCalled();
    analyzeBoardForCombine.mockResolvedValue(second);
    await combineBoards({ ...input, analyzeMissing: true });
    expect(analyzeBoardForCombine).toHaveBeenCalledExactlyOnceWith('b', { ...input, analyzeMissing: true });
    expect(composeBoardPrompt).toHaveBeenCalledWith(expect.objectContaining({ sourceBoards: [first, second] }));
  });

  it('creates no empty or partial board when source analysis fails or a source was deleted', async () => {
    store.getBoard.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...second, style: undefined });
    analyzeBoardForCombine.mockRejectedValueOnce(new Error('Vision unavailable'));
    await expect(combineBoards({ ...input, analyzeMissing: true })).rejects.toThrow('Vision unavailable');
    store.getBoard.mockResolvedValueOnce(first).mockResolvedValueOnce(null);
    await expect(combineBoards(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.createCompositeBoard).not.toHaveBeenCalled();
  });
});
