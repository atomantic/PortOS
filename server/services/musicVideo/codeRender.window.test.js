import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-code-window-') });
});

const h = vi.hoisted(() => ({ encodeComposition: vi.fn(async () => {}), initScripts: [] }));
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: vi.fn(async (_directory, { initScripts }) => { h.initScripts.push(initScripts); return { close: async () => {} }; }),
}));
vi.mock('../htmlComposition/encode.js', () => ({ encodeComposition: h.encodeComposition }));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(),
  findFfmpeg: vi.fn(async () => 'ffmpeg'),
  runFfmpegProcess: vi.fn(async () => ({ ok: true })),
}));

const { prepareCodeRender, encodeCodeComposition } = await import('./codeRender.js');

const project = {
  composition: { mode: 'code' },
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 40, takes: [{ id: 't1' }] }],
  audioAnalysis: { durationSec: 40, beats: [0, 1], downbeats: [0], sections: [{ id: 'a', label: 'All', startSec: 0, endSec: 40 }] },
};

describe('a windowed code render stays on song time', () => {
  it('seeks the page at song time, so wrapped init-script runtimes see the final render\'s clock', async () => {
    const plan = prepareCodeRender(project, { windowStart: 20, windowEnd: 30 });
    // The page paints at the time it is asked to seek; the encoder supplies the window's offset.
    expect(plan.html).toContain('const WINDOW_START = 0;');
    const dir = await mkdtemp(join(tmpdir(), 'code-window-'));
    try {
      await encodeCodeComposition({
        ...plan, audioPath: '/audio.wav', audioStartSec: 20, outputPath: join(dir, 'out.mp4'), directory: `compositions/code-window-test-${Date.now()}`, initScripts: ['init'],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(h.encodeComposition.mock.calls[0][3]).toMatchObject({ offsetSec: 20 });
    expect(h.initScripts[0]).toEqual(['init']);
  });
});
