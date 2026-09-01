import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attachNodeVideo: vi.fn(),
  browserClose: vi.fn(),
  connectOverCDP: vi.fn(),
  getHealthStatus: vi.fn(),
  getLoom: vi.fn(),
  launchBrowser: vi.fn(),
  resolveGalleryImage: vi.fn(),
  saveUploadedGalleryVideoBuffer: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: { connectOverCDP: (...args) => mocks.connectOverCDP(...args) },
}));
vi.mock('../browserService.js', () => ({
  getHealthStatus: (...args) => mocks.getHealthStatus(...args),
  launchBrowser: (...args) => mocks.launchBrowser(...args),
}));
vi.mock('../../lib/pathSafety.js', () => ({
  resolveGalleryImage: (...args) => mocks.resolveGalleryImage(...args),
}));
vi.mock('../../lib/fileUtils.js', () => ({
  sleep: (...args) => mocks.sleep(...args),
}));
vi.mock('../videoUpload.js', () => ({
  MAX_GALLERY_VIDEO_UPLOAD_BYTES: 50 * 1024 * 1024,
  saveUploadedGalleryVideoBuffer: (...args) => mocks.saveUploadedGalleryVideoBuffer(...args),
}));
vi.mock('./records.js', () => ({
  attachNodeVideo: (...args) => mocks.attachNodeVideo(...args),
  getLoom: (...args) => mocks.getLoom(...args),
}));

import {
  _resetFalVideoAutomations,
  FAL_H3_MAX_FREE_URL,
  getFalVideoAutomation,
  startFalVideoAutomation,
} from './falVideoAutomation.js';

const loomWithImage = (image = 'scene.png') => ({
  id: 'loom-1',
  episodes: [{ id: 'ep-1', nodes: [{ id: 'node-1', image }] }],
});

const makeBrowser = ({
  resultError = null,
  errorTexts = [],
  gotoError = null,
  hiddenChallengeFrame = false,
  privacyConsent = false,
  previousVideoUrl = '',
  resultVideoUrl = 'https://v3.fal.media/files/example.mp4',
} = {}) => {
  const prompt = { waitFor: vi.fn(async () => {}), fill: vi.fn(async () => {}), first: vi.fn() };
  prompt.first.mockReturnValue(prompt);
  const image = { setInputFiles: vi.fn(async () => {}), first: vi.fn() };
  image.first.mockReturnValue(image);
  const video = {
    waitFor: resultError ? vi.fn(async () => { throw resultError; }) : vi.fn(async () => {}),
    evaluate: vi.fn()
      .mockResolvedValueOnce(previousVideoUrl)
      .mockResolvedValue(resultVideoUrl),
    first: vi.fn(),
  };
  video.first.mockReturnValue(video);
  const errorLocator = {
    allInnerTexts: vi.fn(async () => errorTexts),
  };
  const controls = new Map(['16:9', '9:16', '1:1', '5s', 'Generate'].map((name) => [name, {
    click: vi.fn(async () => {}),
    waitFor: vi.fn(async () => {}),
  }]));
  let consentVisible = privacyConsent;
  const privacy = {
    click: vi.fn(async () => { consentVisible = false; }),
    first: vi.fn(),
    isVisible: vi.fn(async () => consentVisible),
    waitFor: vi.fn(async ({ state }) => {
      if ((state === 'visible' && !consentVisible) || (state === 'hidden' && consentVisible)) {
        throw new Error(`privacy prompt is not ${state}`);
      }
    }),
  };
  privacy.first.mockReturnValue(privacy);
  const setPrivacyConsent = (visible) => { consentVisible = visible; };
  const apiResponse = {
    body: vi.fn(async () => Buffer.from('example mp4 bytes')),
    dispose: vi.fn(async () => {}),
    headers: vi.fn(() => ({ 'content-length': '17' })),
    ok: vi.fn(() => true),
    status: vi.fn(() => 200),
  };
  const request = { get: vi.fn(async () => apiResponse) };
  const page = {
    close: vi.fn(async () => {}),
    getByRole: vi.fn((_role, { name }) => name === 'Reject All' ? privacy : controls.get(name)),
    goto: gotoError ? vi.fn(async () => { throw gotoError; }) : vi.fn(async () => {}),
    locator: vi.fn((selector) => {
      if (selector.startsWith('textarea')) return prompt;
      if (selector.startsWith('input')) return image;
      if (selector === 'video[src]') return video;
      if (selector.includes('iframe[')) {
        const visibleOnly = selector.split(',').every((part) => part.trim().endsWith(':visible'));
        return { count: vi.fn(async () => hiddenChallengeFrame && !visibleOnly ? 1 : 0) };
      }
      return errorLocator;
    }),
    url: vi.fn(() => 'about:blank'),
  };
  const context = {
    newPage: vi.fn(async () => page),
    pages: vi.fn(() => []),
    request,
  };
  const browser = {
    close: (...args) => mocks.browserClose(...args),
    contexts: vi.fn(() => [context]),
  };
  mocks.connectOverCDP.mockResolvedValue(browser);
  return {
    apiResponse, browser, context, controls, image, page, privacy, prompt, request, setPrivacyConsent, video,
  };
};

const waitForTerminalJob = async (job) => {
  let latest = null;
  await vi.waitFor(() => {
    latest = getFalVideoAutomation(job.loomId, job.episodeId, job.nodeId, job.id);
    expect(['completed', 'failed']).toContain(latest.status);
  });
  return latest;
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetFalVideoAutomations();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.browserClose.mockResolvedValue(undefined);
  mocks.getHealthStatus.mockResolvedValue({ connected: true, cdpHost: '127.0.0.1', cdpPort: 5556 });
  mocks.getLoom.mockResolvedValue(loomWithImage());
  mocks.resolveGalleryImage.mockReturnValue('/example/images/scene.png');
  mocks.sleep.mockResolvedValue(undefined);
  mocks.saveUploadedGalleryVideoBuffer.mockResolvedValue({
    id: 'upload-ab12cd34', filename: 'upload-ab12cd34.mp4',
  });
  mocks.attachNodeVideo.mockResolvedValue({ id: 'node-1', videoHistoryId: 'upload-ab12cd34' });
});

describe('FableLoom fal.ai browser automation', () => {
  it('uploads the scene still and full prompt, downloads the result, and attaches the gallery video', async () => {
    const { apiResponse, controls, image, page, prompt, request } = makeBrowser();
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'One uninterrupted reveal.\n\nAvoid: cuts, logos',
      aspectRatio: '9:16',
    });

    expect(queued).toMatchObject({ source: 'fal-browser', status: 'queued' });
    expect(queued).not.toHaveProperty('prompt');
    const completed = await waitForTerminalJob(queued);

    expect(completed).toMatchObject({
      status: 'completed', videoHistoryId: 'upload-ab12cd34', filename: 'upload-ab12cd34.mp4',
    });
    expect(mocks.connectOverCDP).toHaveBeenCalledWith('http://127.0.0.1:5556', {
      isLocal: true, noDefaults: true, timeout: 30_000,
    });
    expect(page.goto).toHaveBeenCalledWith(FAL_H3_MAX_FREE_URL, expect.any(Object));
    expect(image.setInputFiles).toHaveBeenCalledWith('/example/images/scene.png', expect.any(Object));
    expect(prompt.fill).toHaveBeenCalledWith('One uninterrupted reveal.\n\nAvoid: cuts, logos');
    expect(controls.get('9:16').click).toHaveBeenCalledTimes(1);
    expect(controls.get('5s').click).toHaveBeenCalledTimes(1);
    expect(controls.get('Generate').click).toHaveBeenCalledTimes(1);
    expect(request.get).toHaveBeenCalledWith('https://v3.fal.media/files/example.mp4', {
      failOnStatusCode: false,
      timeout: 120_000,
    });
    expect(apiResponse.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.saveUploadedGalleryVideoBuffer).toHaveBeenCalledWith(
      Buffer.from('example mp4 bytes'),
      'fal.ai H3 Max scene video.mp4',
    );
    expect(mocks.attachNodeVideo).toHaveBeenCalledWith('loom-1', 'ep-1', 'node-1', {
      videoHistoryId: 'upload-ab12cd34',
    });
    expect(mocks.browserClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses a privacy prompt that appears after controls load before filling the scene', async () => {
    const { page, privacy, prompt, setPrivacyConsent } = makeBrowser();
    privacy.waitFor.mockImplementationOnce(async ({ state, timeout }) => {
      expect(state).toBe('visible');
      expect(timeout).toBe(1500);
      setPrivacyConsent(true);
    });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'completed' });
    expect(privacy.click).toHaveBeenCalledTimes(1);
    expect(privacy.click.mock.invocationCallOrder[0]).toBeLessThan(prompt.fill.mock.invocationCallOrder[0]);
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: 'Reject All', exact: true });
  });

  it('coalesces repeated clicks for one scene instead of spending the free allowance twice', async () => {
    makeBrowser();
    let resolveLookup;
    mocks.getLoom.mockImplementationOnce(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const firstRequest = startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });
    const secondRequest = startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'A duplicate click.', aspectRatio: '16:9',
    });
    resolveLookup(loomWithImage());
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(second.id).toBe(first.id);
    await waitForTerminalJob(first);
    expect(mocks.connectOverCDP).toHaveBeenCalledTimes(1);
  });

  it('waits for a new result instead of downloading a video left in the persistent tab', async () => {
    const { request, video } = makeBrowser({
      previousVideoUrl: 'https://v3.fal.media/files/prior-scene.mp4',
      resultVideoUrl: 'https://v3.fal.media/files/current-scene.mp4',
    });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The current scene begins.', aspectRatio: '16:9',
    });

    await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'completed' });
    expect(video.evaluate).toHaveBeenCalledTimes(2);
    expect(request.get).toHaveBeenCalledWith(
      'https://v3.fal.media/files/current-scene.mp4',
      expect.any(Object),
    );
  });

  it('paces polling while a stale persistent-tab result remains visible', async () => {
    const { video } = makeBrowser({
      previousVideoUrl: 'https://v3.fal.media/files/prior-scene.mp4',
      resultVideoUrl: 'https://v3.fal.media/files/current-scene.mp4',
    });
    video.evaluate
      .mockReset()
      .mockResolvedValueOnce('https://v3.fal.media/files/prior-scene.mp4')
      .mockResolvedValueOnce('https://v3.fal.media/files/prior-scene.mp4')
      .mockResolvedValue('https://v3.fal.media/files/current-scene.mp4');
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The current scene begins.', aspectRatio: '16:9',
    });

    await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'completed' });
    expect(mocks.sleep).toHaveBeenCalledWith(2000);
  });

  it('keeps the final result probe finite when the render deadline is reached between checks', async () => {
    const { video } = makeBrowser();
    const now = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce((20 * 60 * 1000) - 1)
      .mockReturnValue(20 * 60 * 1000);
    try {
      const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
        prompt: 'The example door opens.', aspectRatio: '16:9',
      });

      await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'completed' });
      expect(video.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1 });
    } finally {
      now.mockRestore();
    }
  });

  it('ignores a hidden challenge iframe injected during an ordinary fal.ai render', async () => {
    const { video } = makeBrowser({
      hiddenChallengeFrame: true,
      previousVideoUrl: 'https://v3.fal.media/files/prior-scene.mp4',
      resultVideoUrl: 'https://v3.fal.media/files/current-scene.mp4',
    });
    video.evaluate
      .mockReset()
      .mockResolvedValueOnce('https://v3.fal.media/files/prior-scene.mp4')
      .mockResolvedValueOnce('https://v3.fal.media/files/prior-scene.mp4')
      .mockResolvedValue('https://v3.fal.media/files/current-scene.mp4');
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'completed' });
  });

  it('closes a newly created blank tab when fal.ai navigation fails', async () => {
    const { page } = makeBrowser({ gotoError: new Error('navigation failed') });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The current scene begins.', aspectRatio: '16:9',
    });

    await expect(waitForTerminalJob(queued)).resolves.toMatchObject({ status: 'failed' });
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('during Loading the fal.ai video tool'));
  });

  it('requires a current storyboard image before it consumes fal.ai', async () => {
    mocks.getLoom.mockResolvedValueOnce(loomWithImage(null));

    await expect(startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'A text-only request.', aspectRatio: '16:9',
    })).rejects.toMatchObject({ code: 'FAL_SCENE_IMAGE_REQUIRED' });
    expect(mocks.connectOverCDP).not.toHaveBeenCalled();
  });

  it('keeps a finished clip in Media History instead of attaching it to a newly changed still', async () => {
    makeBrowser();
    mocks.getLoom
      .mockResolvedValueOnce(loomWithImage('scene.png'))
      .mockResolvedValueOnce(loomWithImage('scene.png'))
      .mockResolvedValueOnce(loomWithImage('replacement.png'));
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    const failed = await waitForTerminalJob(queued);
    expect(failed).toMatchObject({
      status: 'failed',
      videoHistoryId: 'upload-ab12cd34',
      error: expect.stringContaining('saved in Media History but was not attached'),
    });
    expect(mocks.attachNodeVideo).not.toHaveBeenCalled();
  });

  it('keeps a non-MP4 fal result in Media History without attaching an unplayable scene id', async () => {
    makeBrowser();
    mocks.saveUploadedGalleryVideoBuffer.mockResolvedValueOnce({
      id: 'upload-ab12cd34', filename: 'upload-ab12cd34.webm',
    });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    const failed = await waitForTerminalJob(queued);
    expect(failed).toMatchObject({
      status: 'failed',
      videoHistoryId: 'upload-ab12cd34',
      filename: 'upload-ab12cd34.webm',
      error: expect.stringContaining('saved in Media History but was not attached'),
    });
    expect(mocks.attachNodeVideo).not.toHaveBeenCalled();
  });

  it('surfaces a free-allowance failure without saving or attaching a video', async () => {
    makeBrowser({
      resultError: new Error('result did not appear'),
      errorTexts: ['Daily free limit reached'],
    });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    const failed = await waitForTerminalJob(queued);
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('free video allowance is exhausted'),
    });
    expect(mocks.saveUploadedGalleryVideoBuffer).not.toHaveBeenCalled();
    expect(mocks.attachNodeVideo).not.toHaveBeenCalled();
  });

  it('rejects an oversized result before buffering it into the media gallery', async () => {
    const { apiResponse } = makeBrowser();
    apiResponse.headers.mockReturnValue({ 'content-length': String((50 * 1024 * 1024) + 1) });
    const queued = await startFalVideoAutomation('loom-1', 'ep-1', 'node-1', {
      prompt: 'The example door opens.', aspectRatio: '16:9',
    });

    const failed = await waitForTerminalJob(queued);
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('too large') });
    expect(apiResponse.body).not.toHaveBeenCalled();
    expect(apiResponse.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.saveUploadedGalleryVideoBuffer).not.toHaveBeenCalled();
    expect(mocks.attachNodeVideo).not.toHaveBeenCalled();
  });
});
