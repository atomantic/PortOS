// A retry into an already-delivered launch run must refuse before it spends
// a capture (#9033). This is the fast unit-level counterpart to the real
// Chrome/ffmpeg retry assertion in index.test.js: it mocks the browser and
// encoder so it can assert the *reason* the retry stays cheap — encoding is
// never reached — without paying for a real render.
import { describe, expect, it, vi, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots, sweepStrayTempRoots } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-html-composition-preflight-'),
}));

const closeComposition = vi.fn(async () => {});
const CONTRACT = { durationSec: 15, fps: 12, width: 1280, height: 720, motionBlur: 1, layout: false };

vi.mock('./browser.js', () => ({
  openComposition: async (directory, { validateAssets } = {}) => {
    validateAssets?.(new Map([
      ['/index.html', Buffer.from('<html></html>')],
      ['/plan.md', Buffer.from('A fictional product demonstration.')],
      ['/caption.txt', Buffer.from('Make a clear plan.')],
      ['/storyboard.json', Buffer.from(JSON.stringify({ posterSec: 11, scenes: [{ durationSec: 15, lines: [] }] }))],
    ]));
    return { evaluate: async () => CONTRACT, check: () => {}, close: closeComposition };
  },
}));

const encodeComposition = vi.fn(async () => { throw new Error('encodeComposition must not run on a refused delivery'); });
vi.mock('./encode.js', () => ({
  encodeComposition, encodeContactSheet: vi.fn(), proofTimes: vi.fn(), synthesizeCompositionMusic: vi.fn(),
}));

const { PATHS } = await import('../../lib/fileUtils.js');
const { renderComposition } = await import('./index.js');

describe('renderComposition delivery preflight', () => {
  // Regression: the production-stage signal used to be ignored, allowing
  // fixture teardown to delete source/output while its renderer still ran.
  it.each([false, true])('drains an aborted renderer before settlement (cleanup refusal: %s)', async cleanupFails => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const jobId = randomUUID();
    const controller = new AbortController();
    const encoding = Promise.withResolvers();
    const closing = Promise.withResolvers();
    const releaseClose = Promise.withResolvers();
    const events = [];
    const diagnostics = channel('portos.composition-render.lifecycle');
    const observe = event => { if (event.jobId === jobId) events.push(event); };
    diagnostics.subscribe(observe);
    encodeComposition.mockImplementationOnce(async (_page, _contract, _output, { signal }) => {
      encoding.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    closeComposition.mockImplementationOnce(async () => {
      closing.resolve();
      await releaseClose.promise;
      if (cleanupFails) throw new Error('Synthetic cleanup refusal');
    });
    let settled = false;
    const done = renderComposition({ directory: 'compositions/example', jobId, signal: controller.signal });
    const outcome = done.then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await encoding.promise;
      controller.abort(new Error('Synthetic stage cancellation'));
      await closing.promise;
      expect(settled).toBe(false);
      expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ resource: jobId }));
      releaseClose.resolve();
      expect(await outcome).toMatchObject({ message: 'Synthetic stage cancellation' });
      const blocker = maintenance.status().blockers.find(item => item.resource === jobId);
      if (cleanupFails) expect(blocker).toMatchObject({ unsettled: true });
      else expect(blocker).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ phase: 'settled', failed: true });
      expect(events.every(event => Object.keys(event).every(key => ['jobId', 'phase', 'elapsedMs', 'failed'].includes(key)))).toBe(true);
    } finally {
      releaseClose.resolve();
      await outcome;
      diagnostics.unsubscribe(observe);
      encodeComposition.mockClear();
    }
  });

  it('releases ownership after an ordinary render failure finishes cleanup', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const jobId = randomUUID();
    const directory = `compositions/${jobId}`;
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<html></html>');
    await expect(renderComposition({ directory, jobId })).rejects.toThrow('encodeComposition must not run');
    expect(closeComposition).toHaveBeenLastCalledWith();
    expect(maintenance.status().blockers).not.toContainEqual(expect.objectContaining({ resource: jobId }));
    encodeComposition.mockClear();
  });

  it('retains ownership when a failed render cannot finish browser cleanup', async () => {
    const { maintenance } = await import('../../lib/maintenanceAdmission.js');
    const jobId = randomUUID();
    const directory = `compositions/${jobId}`;
    await mkdir(join(PATHS.data, directory), { recursive: true });
    await writeFile(join(PATHS.data, directory, 'index.html'), '<html></html>');
    closeComposition.mockRejectedValueOnce(new Error('Context cleanup failed'));
    await expect(renderComposition({ directory, jobId })).rejects.toThrow();
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ kind: 'composition', resource: jobId, unsettled: true }));
    encodeComposition.mockClear();
  });

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
