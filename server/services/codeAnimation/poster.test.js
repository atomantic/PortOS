// The poster capture queue: one jailed browser at a time, one capture per id
// in flight, a change event only for a written poster, and no relaunch after a
// failure or on a host without preview isolation.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jobs = vi.hoisted(() => ({
  getCodeAnimationJobRecord: vi.fn(),
  isCodeAnimationJobId: (id) => /^[0-9a-f-]{36}$/.test(id),
  readCodeAnimationHtml: vi.fn(async () => '<canvas></canvas>'),
  saveCodeAnimationPoster: vi.fn(async () => {}),
}));
vi.mock('./jobStore.js', () => jobs);
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));
vi.mock('../generatedPreview/codeAnimationPage.js', () => ({
  stageCodeAnimationPage: vi.fn(async () => ({ scratchRoot: '/nonexistent/poster-scratch', directory: 'scratch/composition' })),
}));
const browser = vi.hoisted(() => ({ openComposition: vi.fn(), open: 0, peak: 0 }));
vi.mock('../htmlComposition/browser.js', () => ({ openComposition: browser.openComposition }));

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

const page = (result) => ({
  send: vi.fn(async () => ({})),
  evaluate: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return result;
  }),
  close: vi.fn(async () => { browser.open -= 1; }),
});

let captureCodeAnimationPoster;
let emitCodeAnimationChanged;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  browser.open = 0;
  browser.peak = 0;
  jobs.getCodeAnimationJobRecord.mockImplementation(async (id) => ({ id, status: 'completed', frame: { durationSeconds: 10 } }));
  browser.openComposition.mockImplementation(async () => {
    browser.open += 1;
    browser.peak = Math.max(browser.peak, browser.open);
    return page(Buffer.from('jpeg').toString('base64'));
  });
  ({ captureCodeAnimationPoster } = await import('./poster.js'));
  ({ emitCodeAnimationChanged } = await import('../socket.js'));
});

describe('captureCodeAnimationPoster', () => {
  it('shares one capture per id, draws ids one at a time, and announces each written poster', async () => {
    const results = await Promise.all([captureCodeAnimationPoster(ID_A), captureCodeAnimationPoster(ID_A), captureCodeAnimationPoster(ID_B)]);
    expect(results).toEqual([true, true, true]);
    expect(browser.openComposition).toHaveBeenCalledTimes(2);
    expect(browser.peak).toBe(1);
    expect(jobs.saveCodeAnimationPoster.mock.calls.map(([id, bytes]) => [id, bytes.toString()])).toEqual([[ID_A, 'jpeg'], [ID_B, 'jpeg']]);
    expect(emitCodeAnimationChanged.mock.calls).toEqual([[ID_A, 'poster'], [ID_B, 'poster']]);
    expect(browser.open).toBe(0);
  });

  it('skips an unfinished job and does not relaunch a capture that drew nothing', async () => {
    jobs.getCodeAnimationJobRecord.mockResolvedValueOnce({ id: ID_A, status: 'running' });
    expect(await captureCodeAnimationPoster(ID_A)).toBe(false);
    expect(browser.openComposition).not.toHaveBeenCalled();

    browser.openComposition.mockImplementationOnce(async () => page(null));
    expect(await captureCodeAnimationPoster(ID_B)).toBe(false);
    expect(await captureCodeAnimationPoster(ID_B)).toBe(false);
    expect(browser.openComposition).toHaveBeenCalledTimes(1);
    expect(jobs.saveCodeAnimationPoster).not.toHaveBeenCalled();
    expect(emitCodeAnimationChanged).not.toHaveBeenCalled();
  });

  it('stops launching browsers once the host reports preview isolation is unavailable', async () => {
    browser.openComposition.mockImplementationOnce(async () => {
      throw Object.assign(new Error('no jail'), { code: 'PREVIEW_ISOLATION_UNAVAILABLE' });
    });
    expect(await captureCodeAnimationPoster(ID_A)).toBe(false);
    expect(await captureCodeAnimationPoster(ID_B)).toBe(false);
    expect(browser.openComposition).toHaveBeenCalledTimes(1);
  });
});
