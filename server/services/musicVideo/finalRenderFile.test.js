import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { videos: '/mock/videos' },
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  safeUnder: vi.fn((root, filename) => (filename && !filename.includes('..') ? `${root}/${filename}` : null)),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../videoGen/history.js', () => ({
  getHistoryItem: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { getHistoryItem } from '../videoGen/history.js';
import { resolveRenderVideoFile } from './finalRenderFile.js';

describe('finalRenderFile helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveRenderVideoFile', () => {
    it('returns null for null or empty renderHistoryId', async () => {
      expect(await resolveRenderVideoFile(null)).toBeNull();
      expect(await resolveRenderVideoFile('')).toBeNull();
      expect(await resolveRenderVideoFile(undefined)).toBeNull();
      expect(getHistoryItem).not.toHaveBeenCalled();
    });

    it('returns null if history item is not found', async () => {
      getHistoryItem.mockResolvedValueOnce(null);
      expect(await resolveRenderVideoFile('unknown-id')).toBeNull();
      expect(getHistoryItem).toHaveBeenCalledWith('unknown-id');
    });

    it('returns null if history item has missing or unsafe filename', async () => {
      getHistoryItem.mockResolvedValueOnce({ id: 'bad-fn', filename: null });
      expect(await resolveRenderVideoFile('bad-fn')).toBeNull();

      getHistoryItem.mockResolvedValueOnce({ id: 'traversal', filename: '../outside.mp4' });
      expect(await resolveRenderVideoFile('traversal')).toBeNull();
    });

    it('returns null if the file does not exist on disk', async () => {
      getHistoryItem.mockResolvedValueOnce({ id: 'r1', filename: 'render-1.mp4' });
      existsSync.mockReturnValueOnce(false);
      expect(await resolveRenderVideoFile('r1')).toBeNull();
      expect(existsSync).toHaveBeenCalledWith('/mock/videos/render-1.mp4');
    });

    it('returns { entry, path } when entry and file exist', async () => {
      const entry = { id: 'r1', filename: 'render-1.mp4' };
      getHistoryItem.mockResolvedValueOnce(entry);
      existsSync.mockReturnValueOnce(true);
      const res = await resolveRenderVideoFile('r1');
      expect(res).toEqual({ entry, path: '/mock/videos/render-1.mp4' });
    });
  });
});
