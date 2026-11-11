import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject } from './projects.js';
import { startLyricAlign } from './lyricAlignJob.js';

vi.mock('./projects.js', () => ({ getProject: vi.fn() }));
vi.mock('./lyricAlign.js', () => ({ alignProjectLyrics: vi.fn() }));

describe('lyric alignment job refusals', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('logs an unsupported word as a refusal with the line number only', async () => {
    getProject.mockResolvedValue({ id: 'proj-1', lyricCues: [{ id: 'cue-1', text: 'Example ışık' }] });
    const align = vi.fn(async () => {
      throw new ServerError(
        'MMS_FA cannot align "ışık" on lyric line 2: spell numbers out and use Latin letters.',
        { status: 422, code: 'LYRIC_ALIGN_CTC_UNSUPPORTED_TEXT' },
      );
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await startLyricAlign('proj-1', { align });
    await vi.waitFor(() => {
      expect(log.mock.calls.some(([line]) => String(line).includes('refused unsupported text on line 2'))).toBe(true);
    });
    const refusal = log.mock.calls.map(([line]) => String(line)).find((line) => line.includes('refused unsupported text'));
    expect(refusal.startsWith('🚫 ')).toBe(true);
    expect(refusal).not.toContain('ışık');
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});
