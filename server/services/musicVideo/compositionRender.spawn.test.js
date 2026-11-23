import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = { proc: null, page: null };
vi.mock('../../lib/childProcess.js', async (orig) => ({ ...(await orig()), spawn: () => state.proc }));
vi.mock('../../lib/ffmpeg.js', () => ({ findFfmpeg: async () => '/bin/ffmpeg' }));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: async () => state.page }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('./composition.js', () => ({
  buildTypographyDocument: () => '<html></html>',
  LYRIC_FONT_FILE: 'f.ttf', TITLE_CARD_MONO_FONT_FILE: 'm.ttf',
  overlayWindows: () => [{ startSec: 0, endSec: 1 }],
}));

const { renderTypographyOverlays } = await import('./compositionRender.js');

const fakeProc = (pid) => {
  const p = new EventEmitter();
  p.pid = pid; p.stderr = new EventEmitter(); p.stdin = Object.assign(new EventEmitter(), { write: () => {}, end: () => {} });
  p.kill = vi.fn();
  return p;
};
const fakePage = (closeImpl) => ({ check: () => {}, send: async () => ({ data: '' }), evaluate: async () => {}, close: closeImpl });
const args = { jobId: 'j-spawn', cues: [{ startSec: 0, endSec: 1 }], width: 4, height: 4, fps: 2, durationSec: 1 };

describe('renderTypographyOverlays failure paths (#17925)', () => {
  it('rejects promptly on a pre-spawn ffmpeg error that never emits close', async () => {
    state.proc = fakeProc(undefined);
    state.page = fakePage(async () => {});
    const run = renderTypographyOverlays(args);
    setTimeout(() => state.proc.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), 50);
    await expect(run).rejects.toThrow(/ENOENT/);
    expect(state.proc.kill).not.toHaveBeenCalled();
  });

  it('keeps the original error when page.close() throws', async () => {
    state.proc = fakeProc(undefined);
    state.page = fakePage(async () => { throw new Error('browser crashed'); });
    const run = renderTypographyOverlays(args);
    setTimeout(() => state.proc.emit('error', new Error('spawn ffmpeg ENOENT')), 50);
    await expect(run).rejects.toThrow(/ENOENT/);
  });
});
