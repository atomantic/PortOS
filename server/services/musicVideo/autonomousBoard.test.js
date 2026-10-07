import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
const board = {
  createBoard: vi.fn(async () => ({ id: 'mb-1' })),
  addBoardItem: vi.fn(async (_id, input) => ({ id: `n-${input.text}` })),
  updateBoard: vi.fn(async () => { calls.push('style'); }),
  renderBoardItem: vi.fn(async (_id, itemId) => { calls.push(`render:${itemId}`); return { jobId: 'j' }; }),
};
vi.mock('../moodBoard/index.js', () => board);

const { createAutonomousMoodBoard } = await import('./autonomousBoard.js');
const spec = { name: 'B', description: 'd', notes: ['a', 'b'], stylePrompt: 'neon', negativePrompt: 'text' };

describe('createAutonomousMoodBoard', () => {
  beforeEach(() => { vi.clearAllMocks(); calls.length = 0; });

  it('renders every note on the run route after the style is set, so the prompt carries the look', async () => {
    const route = { target: 'music-video', mode: 'local', model: 'qwen-image-2.1' };
    await createAutonomousMoodBoard(spec, { renderRoute: route });
    expect(calls).toEqual(['style', 'render:n-a', 'render:n-b']);
    expect(board.renderBoardItem).toHaveBeenCalledWith('mb-1', 'n-a', route);
  });

  it('keeps a note as text when its render cannot be queued, and keeps going', async () => {
    board.renderBoardItem.mockRejectedValueOnce(new Error('backend off'));
    await expect(createAutonomousMoodBoard(spec, { renderRoute: { mode: 'local' } })).resolves.toEqual({ id: 'mb-1' });
    expect(board.renderBoardItem).toHaveBeenCalledTimes(2);
  });

  it('builds a text-only board without a render route', async () => {
    await createAutonomousMoodBoard(spec);
    expect(board.renderBoardItem).not.toHaveBeenCalled();
  });
});
