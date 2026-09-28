// A retry into an already-delivered launch run must refuse before it spends
// a capture (#9033). This is the fast unit-level counterpart to the real
// Chrome/ffmpeg retry assertion in index.test.js: it mocks the browser and
// encoder so it can assert the *reason* the retry stays cheap — encoding is
// never reached — without paying for a real render.
import { describe, expect, it, vi, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots, sweepStrayTempRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-html-composition-preflight-'),
}));

const CONTRACT = { durationSec: 15, fps: 12, width: 1280, height: 720, motionBlur: 1, layout: false };

vi.mock('./browser.js', () => ({
  openComposition: async (directory, { validateAssets } = {}) => {
    validateAssets?.(new Map([
      ['/index.html', Buffer.from('<html></html>')],
      ['/plan.md', Buffer.from('A fictional product demonstration.')],
      ['/caption.txt', Buffer.from('Make a clear plan.')],
      ['/storyboard.json', Buffer.from(JSON.stringify({ posterSec: 11, scenes: [{ durationSec: 15, lines: [] }] }))],
    ]));
    return { evaluate: async () => CONTRACT, check: () => {}, close: async () => {} };
  },
}));

const encodeComposition = vi.fn(async () => { throw new Error('encodeComposition must not run on a refused delivery'); });
vi.mock('./encode.js', () => ({
  encodeComposition, encodeContactSheet: vi.fn(), proofTimes: vi.fn(), synthesizeCompositionMusic: vi.fn(),
}));

const { PATHS } = await import('../../lib/fileUtils.js');
const { renderComposition } = await import('./index.js');

describe('renderComposition delivery preflight', () => {
  it('refuses with EEXIST before encoding when a delivery file already exists', async () => {
    const runId = randomUUID();
    const directory = `launch-videos/example/${runId}/composition`;
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<html></html>');

    // Simulate an already-delivered run: only `video.mp4` need exist for the
    // preflight to refuse, since it checks every name deliver() would write.
    const runRoot = join(PATHS.data, 'launch-videos', 'example', runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, 'video.mp4'), 'already delivered');

    const jobId = randomUUID();
    await expect(renderComposition({
      directory, jobId, launchVideo: { targetDurationSec: 15, appId: 'example', runId },
    })).rejects.toThrow(/EEXIST/);

    expect(encodeComposition).not.toHaveBeenCalled();
  });

  afterAll(async () => {
    cleanupTempDataRoots();
    await sweepStrayTempRoots('portos-html-composition-preflight-');
  });
});
