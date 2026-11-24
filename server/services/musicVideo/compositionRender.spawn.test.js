import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const state = { proc: null, page: null, spawnError: null };
vi.mock('../../lib/paths.js', async (orig) => makePathsProxy(await orig(), { dataRoot: () => lazyTempDataRoot('composition-spawn-') }));
// Emit from spawn, as Node does: after the caller's listeners attach, however slow the setup before it was.
vi.mock('../../lib/childProcess.js', async (orig) => ({
  ...(await orig()),
  spawn: () => { setImmediate(() => state.proc.emit('error', state.spawnError)); return state.proc; },
}));
vi.mock('../../lib/ffmpeg.js', () => ({ findFfmpeg: async () => '/bin/ffmpeg' }));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: async () => state.page }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('./composition.js', () => ({
  buildTypographyDocument: () => '<html></html>',
  LYRIC_FONT_FILE: 'f.ttf', TITLE_CARD_MONO_FONT_FILE: 'm.ttf',
  overlayWindows: () => [{ startSec: 0, endSec: 1 }],
}));

const { renderTypographyOverlays } = await import('./compositionRender.js');
afterAll(cleanupTempDataRoots);

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
    state.spawnError = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    await expect(renderTypographyOverlays(args)).rejects.toThrow(/ENOENT/);
    expect(state.proc.kill).not.toHaveBeenCalled();
  });

  it('keeps the original error when page.close() throws', async () => {
    state.proc = fakeProc(undefined);
    state.page = fakePage(async () => { throw new Error('browser crashed'); });
    state.spawnError = new Error('spawn ffmpeg ENOENT');
    await expect(renderTypographyOverlays(args)).rejects.toThrow(/ENOENT/);
  });
});
