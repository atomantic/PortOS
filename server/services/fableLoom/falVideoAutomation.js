/**
 * User-triggered fal.ai H3 Max browser automation for one FableLoom scene.
 *
 * Jobs run serially against PortOS's persistent CDP browser so two scene
 * requests cannot overwrite the same free-tool form. The browser keeps the
 * user's fal.ai session; Playwright only fills the authored prompt, uploads
 * the scene's current storyboard still, starts the render, and downloads the
 * finished clip. The durable gallery write + scene attachment happen here,
 * independent of whether the initiating client stays mounted.
 */

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { ServerError } from '../../lib/errorHandler.js';
import { sleep } from '../../lib/fileUtils.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { getHealthStatus, launchBrowser } from '../browserService.js';
import {
  MAX_GALLERY_VIDEO_UPLOAD_BYTES,
  saveUploadedGalleryVideoBuffer,
} from '../videoUpload.js';
import { attachNodeVideo, getLoom } from './records.js';

export const FAL_H3_MAX_FREE_URL = 'https://fal.ai/tools/minimax-h3-max';

const FAL_RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const FAL_CONTROL_TIMEOUT_MS = 2 * 60 * 1000;
const FAL_RESULT_POLL_MS = 2000;
const FAL_PRIVACY_SETTLE_MS = 1500;
const FAL_PRIVACY_LATE_CHECK_MS = 250;
const FAL_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const FAL_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);

const jobs = new Map();
const latestJobByScene = new Map();
const pendingJobByScene = new Map();
let runTail = Promise.resolve();

const sceneKey = (loomId, episodeId, nodeId) => JSON.stringify([loomId, episodeId, nodeId]);

const findScene = (loom, episodeId, nodeId) => {
  const episode = loom?.episodes?.find((item) => item.id === episodeId);
  const node = episode?.nodes?.find((item) => item.id === nodeId);
  return { episode, node };
};

const publicJob = (job) => ({
  id: job.id,
  source: 'fal-browser',
  loomId: job.loomId,
  episodeId: job.episodeId,
  nodeId: job.nodeId,
  status: job.status,
  statusMsg: job.statusMsg,
  progress: job.progress,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  completedAt: job.completedAt,
  error: job.error,
  videoHistoryId: job.videoHistoryId,
  filename: job.filename,
});

const pruneJobs = () => {
  const cutoff = Date.now() - FAL_JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (ACTIVE_STATUSES.has(job.status) || new Date(job.completedAt || job.createdAt).getTime() >= cutoff) continue;
    jobs.delete(id);
    const key = sceneKey(job.loomId, job.episodeId, job.nodeId);
    if (latestJobByScene.get(key) === id) latestJobByScene.delete(key);
  }
};

const setJobProgress = (job, statusMsg, progress) => {
  job.status = 'running';
  job.statusMsg = statusMsg;
  job.progress = progress;
};

const falAspectRatio = (requested) => {
  if (FAL_ASPECT_RATIOS.has(requested)) return requested;
  // fal's free tool has no 4:3 option. Preserve landscape orientation rather
  // than silently rotating or square-cropping a classic FableLoom frame.
  return '16:9';
};

/**
 * Dismisses fal.ai's asynchronously injected privacy-choice modal when present.
 *
 * The persistent browser profile remembers a prior choice. When no choice is
 * stored, fal.ai can render the tool controls before the modal arrives, so the
 * caller gives the CMP a short settle window before touching the form. Reject
 * All keeps this user-triggered automation from silently opting into tracking.
 *
 * @param {import('playwright-core').Page} page - Active Playwright page.
 * @param {object} [options] - Visibility wait options.
 * @param {number} [options.waitMs=0] - Maximum time to wait for the choice.
 * @returns {Promise<boolean>} Whether a visible privacy prompt was dismissed.
 */
const dismissFalPrivacyConsent = async (page, { waitMs = 0 } = {}) => {
  const rejectAll = page.getByRole('button', { name: 'Reject All', exact: true }).first();
  const visible = waitMs > 0
    ? await rejectAll.waitFor({ state: 'visible', timeout: waitMs }).then(() => true).catch(() => false)
    : await rejectAll.isVisible().catch(() => false);
  if (!visible) return false;
  await rejectAll.click({ timeout: FAL_CONTROL_TIMEOUT_MS });
  await rejectAll.waitFor({ state: 'hidden', timeout: FAL_CONTROL_TIMEOUT_MS });
  return true;
};

/**
 * Resolves the active Chrome DevTools Protocol endpoint URL for the PortOS Browser.
 *
 * @returns {Promise<string>} CDP HTTP endpoint URL (e.g. http://127.0.0.1:5556).
 * @throws {ServerError} When PortOS Browser is not running and cannot be launched.
 */
const cdpEndpoint = async () => {
  let health = await getHealthStatus();
  if (!health.connected) health = await launchBrowser();
  if (!health.connected) {
    throw new ServerError('PortOS Browser is unavailable. Start it in Settings > Browser, then retry.', {
      status: 503,
      code: 'PORTOS_BROWSER_UNAVAILABLE',
    });
  }
  const host = health.cdpHost === '0.0.0.0' || health.cdpHost === '::'
    ? '127.0.0.1'
    : health.cdpHost;
  const endpointHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${endpointHost}:${health.cdpPort}`;
};

/**
 * Checks for visible error messages, CAPTCHA challenges, rate limits, or auth walls on the fal.ai page.
 *
 * @param {import('playwright-core').Page} page - Active Playwright page.
 * @returns {Promise<string|null>} User-friendly error diagnosis if found, otherwise null.
 */
const visibleFalFailure = async (page) => {
  const text = await page.locator('[role="alert"]:visible, .text-error:visible').allInnerTexts().catch(() => []);
  const message = text.map((item) => item.trim()).find(Boolean) || '';
  const challengeFrames = await page.locator([
    'iframe[src*="captcha" i]:visible',
    'iframe[src*="challenge" i]:visible',
    'iframe[title*="captcha" i]:visible',
    'iframe[title*="challenge" i]:visible',
  ].join(', ')).count().catch(() => 0);
  if (challengeFrames > 0 || /captcha|verify (?:that )?you are human|human verification/i.test(message)) {
    return 'fal.ai needs human verification in the PortOS Browser. Complete it there, then retry.';
  }
  if (/daily limit|free (?:video )?limit|quota|too many requests/i.test(message)) {
    return 'fal.ai reports that the free video allowance is exhausted. Retry when the allowance resets.';
  }
  if (/sign in (?:to|with)|log in (?:to|with)/i.test(message)) {
    return 'fal.ai needs a signed-in session. Sign in through the PortOS Browser, then retry.';
  }
  return /error|fail(?:ed|ure)?|unable|invalid|unsupported|try again/i.test(message)
    ? `fal.ai could not generate the video: ${message.slice(0, 240)}`
    : null;
};

/**
 * Maps uncaught errors to sanitized user-facing error explanations.
 *
 * @param {Error|ServerError} error - Caught error.
 * @returns {string} User-facing failure summary.
 */
const safeFailureMessage = (error) => {
  if (error instanceof ServerError) return error.message;
  if (error?.name === 'TimeoutError') {
    return 'fal.ai did not expose the expected controls in the PortOS Browser. Inspect the tab, then retry.';
  }
  return 'fal.ai browser automation failed. Inspect the PortOS Browser tab, then retry.';
};

/**
 * Reads the current video source URL from the given video locator.
 *
 * @param {import('playwright-core').Locator} resultVideo - Video element locator.
 * @returns {Promise<string>} Video source URL.
 */
const readVideoSource = (resultVideo) => resultVideo
  .evaluate((video) => video.currentSrc || video.src || '')
  .catch(() => '');

/**
 * Polls the fal.ai result video element until a new video URL appears or an error is diagnosed.
 *
 * @param {import('playwright-core').Page} page - Active Playwright page.
 * @param {import('playwright-core').Locator} resultVideo - Video element locator.
 * @param {string} previousSourceUrl - URL from any previous completed render.
 * @returns {Promise<string>} Downloadable URL of the generated video.
 * @throws {ServerError} When rendering times out or fal.ai shows an error/captcha.
 */
const waitForFalResult = async (page, resultVideo, previousSourceUrl) => {
  const deadline = Date.now() + FAL_RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const visible = await resultVideo.waitFor({
      state: 'visible',
      // Playwright interprets zero as "no timeout". The clock can reach the
      // deadline between the loop check and this calculation, so keep the
      // final probe finite instead of wedging the global job queue forever.
      timeout: Math.max(1, Math.min(FAL_RESULT_POLL_MS, remaining)),
    }).then(() => true).catch(() => false);
    if (visible) {
      const sourceUrl = await readVideoSource(resultVideo);
      if (sourceUrl && sourceUrl !== previousSourceUrl) return sourceUrl;
    }

    // fal.ai can reject a request immediately (quota, auth, or CAPTCHA). Check
    // between short visibility waits so the scene reports that outcome now,
    // rather than looking busy until the full render timeout expires.
    const failure = await visibleFalFailure(page);
    if (failure) {
      throw new ServerError(failure, { status: 502, code: 'FAL_VIDEO_GENERATION_FAILED' });
    }
    await sleep(Math.min(FAL_RESULT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new ServerError(
    'fal.ai did not finish the video before the 20-minute timeout. Inspect the PortOS Browser tab, then retry.',
    { status: 504, code: 'FAL_VIDEO_TIMEOUT' },
  );
};

/**
 * Downloads the generated video buffer from fal.ai using the authenticated browser context.
 *
 * @param {import('playwright-core').BrowserContext} context - Playwright browser context.
 * @param {string} sourceUrl - Video asset URL to download.
 * @returns {Promise<Buffer>} Video file buffer.
 * @throws {ServerError} On non-200 HTTP response or when video size exceeds max upload limits.
 */
const readFalVideo = async (context, sourceUrl) => {
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new ServerError('fal.ai finished, but did not expose a downloadable video URL.', {
      status: 502,
      code: 'FAL_VIDEO_DOWNLOAD_FAILED',
    });
  }

  // fal.ai's own Download action fetches this result URL before creating its
  // anchor. Fetch through Playwright's browser-context request client instead:
  // it shares the persistent profile's cookies and returns the bytes directly
  // to PortOS even when an attached default CDP context does not emit download
  // events for browser-managed anchor downloads.
  const response = await context.request.get(sourceUrl, {
    failOnStatusCode: false,
    timeout: FAL_CONTROL_TIMEOUT_MS,
  });
  if (!response.ok()) {
    await response.dispose();
    throw new ServerError(`fal.ai video download failed with status ${response.status()}.`, {
      status: 502,
      code: 'FAL_VIDEO_DOWNLOAD_FAILED',
    });
  }
  const declaredSize = Number(response.headers()['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_GALLERY_VIDEO_UPLOAD_BYTES) {
    await response.dispose();
    throw new ServerError('fal.ai returned a video that is too large for the PortOS media gallery.', {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }
  const buffer = await response.body().finally(() => response.dispose().catch(() => {}));
  if (buffer.length > MAX_GALLERY_VIDEO_UPLOAD_BYTES) {
    throw new ServerError('fal.ai returned a video that is too large for the PortOS media gallery.', {
      status: 400,
      code: 'FILE_TOO_LARGE',
    });
  }
  return buffer;
};

/**
 * Executes a single serialized fal.ai video generation job via Playwright CDP automation.
 *
 * @param {object} job - The internal job record to execute.
 * @returns {Promise<void>}
 */
const executeJob = async (job) => {
  let browser = null;
  let createdPage = null;
  try {
    job.startedAt = new Date().toISOString();
    setJobProgress(job, 'Opening the PortOS Browser…', 0.05);

    const latestAtStart = await getLoom(job.loomId);
    const { node: sceneAtStart } = findScene(latestAtStart, job.episodeId, job.nodeId);
    if (!sceneAtStart || sceneAtStart.image !== job.imageFilename) {
      throw new ServerError('The scene image changed before fal.ai started. Retry with the current image.', {
        status: 409,
        code: 'FAL_SCENE_IMAGE_CHANGED',
      });
    }
    const imagePath = resolveGalleryImage(job.imageFilename);
    if (!imagePath) {
      throw new ServerError('The scene image is no longer available. Generate or restore it, then retry.', {
        status: 409,
        code: 'FAL_SCENE_IMAGE_UNAVAILABLE',
      });
    }

    browser = await chromium.connectOverCDP(await cdpEndpoint(), {
      isLocal: true,
      noDefaults: true,
      timeout: 30_000,
    });
    const context = browser.contexts()[0];
    if (!context) {
      throw new ServerError('PortOS Browser has no usable profile context.', {
        status: 503,
        code: 'PORTOS_BROWSER_UNAVAILABLE',
      });
    }
    const existingPage = context.pages()
      .find((candidate) => candidate.url().includes('/tools/minimax-h3-max'));
    createdPage = existingPage ? null : await context.newPage();
    const page = existingPage || createdPage;
    setJobProgress(job, 'Loading the fal.ai video tool…', 0.1);
    await page.goto(FAL_H3_MAX_FREE_URL, { waitUntil: 'domcontentloaded', timeout: FAL_CONTROL_TIMEOUT_MS });

    const promptInput = page.locator('textarea[placeholder^="Describe the video you want"]').first();
    const imageInput = page.locator('input[type="file"][accept*="image"]').first();
    setJobProgress(job, 'Waiting for fal.ai controls…', 0.12);
    await promptInput.waitFor({ state: 'visible', timeout: FAL_CONTROL_TIMEOUT_MS });
    // The privacy-choice UI is injected after the tool controls become
    // visible. Let it settle before filling the form so its overlay cannot
    // clear the prompt or intercept the eventual Generate click.
    await dismissFalPrivacyConsent(page, { waitMs: FAL_PRIVACY_SETTLE_MS });

    setJobProgress(job, 'Uploading the scene image to fal.ai…', 0.15);
    await imageInput.setInputFiles(imagePath, { timeout: FAL_CONTROL_TIMEOUT_MS });
    await promptInput.fill(job.prompt);
    await page.getByRole('button', { name: falAspectRatio(job.aspectRatio), exact: true }).click();
    await page.getByRole('button', { name: '5s', exact: true }).click();

    const generate = page.getByRole('button', { name: 'Generate', exact: true });
    await generate.waitFor({ state: 'visible', timeout: FAL_CONTROL_TIMEOUT_MS });
    const resultVideo = page.locator('video[src]').first();
    // A persistent fal.ai tab can still show the prior scene's completed
    // video. Snapshot it before submitting so that only a new result URL can
    // satisfy this job.
    const previousSourceUrl = await readVideoSource(resultVideo);
    // Re-check immediately before submission in case the CMP appeared during
    // the upload/fill sequence rather than during the initial settle window.
    await dismissFalPrivacyConsent(page, { waitMs: FAL_PRIVACY_LATE_CHECK_MS });
    await generate.click({ timeout: FAL_CONTROL_TIMEOUT_MS });

    setJobProgress(job, 'Generating the scene video on fal.ai…', 0.3);
    const sourceUrl = await waitForFalResult(page, resultVideo, previousSourceUrl);

    setJobProgress(job, 'Downloading the fal.ai video…', 0.8);
    const videoBuffer = await readFalVideo(context, sourceUrl);

    setJobProgress(job, 'Saving the video to FableLoom…', 0.9);
    const galleryVideo = await saveUploadedGalleryVideoBuffer(
      videoBuffer,
      'fal.ai H3 Max scene video.mp4',
    );
    job.videoHistoryId = galleryVideo.id;
    job.filename = galleryVideo.filename;

    // FableLoom scenes still address a gallery clip as `${historyId}.mp4`.
    // Keep any valid alternate container in Media History, but do not attach
    // a record whose scene preview URL cannot resolve.
    if (galleryVideo.filename !== `${galleryVideo.id}.mp4`) {
      throw new ServerError(
        'fal.ai returned a non-MP4 video. It is saved in Media History but was not attached.',
        { status: 502, code: 'FAL_VIDEO_UNSUPPORTED_CONTAINER' },
      );
    }

    const latestBeforeAttach = await getLoom(job.loomId);
    const { node: sceneBeforeAttach } = findScene(latestBeforeAttach, job.episodeId, job.nodeId);
    if (!sceneBeforeAttach || sceneBeforeAttach.image !== job.imageFilename) {
      throw new ServerError('The scene image changed while fal.ai was rendering. The video is saved in Media History but was not attached.', {
        status: 409,
        code: 'FAL_SCENE_IMAGE_CHANGED',
      });
    }
    const attached = await attachNodeVideo(job.loomId, job.episodeId, job.nodeId, {
      videoHistoryId: galleryVideo.id,
    });
    if (!attached) {
      throw new ServerError('The scene was removed while fal.ai was rendering. The video is saved in Media History but was not attached.', {
        status: 409,
        code: 'FAL_SCENE_UNAVAILABLE',
      });
    }

    job.status = 'completed';
    job.statusMsg = 'Scene video ready';
    job.progress = 1;
    job.completedAt = new Date().toISOString();
    console.log(`🎬 fal.ai scene video attached: ${galleryVideo.id}`);
  } catch (error) {
    const message = safeFailureMessage(error);
    const diagnostic = [error?.name || 'Error', error?.code].filter(Boolean).join('/');
    const failedStage = job.statusMsg || 'fal.ai automation';
    job.status = 'failed';
    job.statusMsg = 'fal.ai video failed';
    job.error = message;
    job.completedAt = new Date().toISOString();
    console.error(`❌ fal.ai scene video failed: ${message} (${diagnostic} during ${failedStage})`);
  } finally {
    // Keep a real fal.ai page open for login/CAPTCHA inspection, but do not
    // accumulate blank tabs when navigation itself failed.
    if (createdPage?.url() === 'about:blank') await createdPage.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
};

/**
 * Enqueues a user-triggered fal.ai H3 Max video automation job for a FableLoom scene.
 *
 * Checks scene existence and validates that an approved storyboard still is present,
 * registers the queued job, and attaches it to the serialized browser runner tail.
 *
 * @param {string} loomId - The ID of the parent loom story.
 * @param {string} episodeId - The ID of the episode containing the scene.
 * @param {string} nodeId - The ID of the scene node to render video for.
 * @param {object} options - Generation options.
 * @param {string} options.prompt - Authored video generation prompt and camera direction.
 * @param {'16:9'|'9:16'|'1:1'} [options.aspectRatio='16:9'] - Target video aspect ratio.
 * @returns {Promise<object>} Public job status descriptor.
 * @throws {ServerError} When scene/image is missing or browser is unavailable.
 */
export async function startFalVideoAutomation(loomId, episodeId, nodeId, {
  prompt,
  aspectRatio = '16:9',
}) {
  pruneJobs();
  const key = sceneKey(loomId, episodeId, nodeId);
  const prior = jobs.get(latestJobByScene.get(key));
  if (prior && ACTIVE_STATUSES.has(prior.status)) return publicJob(prior);

  const pending = pendingJobByScene.get(key);
  if (pending) return await pending;

  // Reserve this scene before the first lookup yields. Without this promise,
  // two POSTs arriving in the same render can both pass the active-job check
  // and spend two free fal.ai allowances before either job is registered.
  const createJob = (async () => {
    const loom = await getLoom(loomId);
    const { node } = findScene(loom, episodeId, nodeId);
    if (!node) {
      throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
    }
    if (!node.image || !resolveGalleryImage(node.image)) {
      throw new ServerError('Generate a scene image before starting fal.ai video automation.', {
        status: 409,
        code: 'FAL_SCENE_IMAGE_REQUIRED',
      });
    }

    const job = {
      id: `fal-${randomUUID()}`,
      loomId,
      episodeId,
      nodeId,
      prompt,
      aspectRatio,
      imageFilename: node.image,
      status: 'queued',
      statusMsg: 'Waiting for the fal.ai browser…',
      progress: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      videoHistoryId: null,
      filename: null,
    };
    jobs.set(job.id, job);
    latestJobByScene.set(key, job.id);

    // The free tool exposes one form in one persistent browser profile. Keep
    // every user-requested scene job, but serialize them so a later click
    // cannot replace the prompt/image of an in-flight render.
    runTail = runTail.then(() => executeJob(job));
    // Snapshot the queued state before the serialized runner can advance it;
    // both same-scene callers receive the same initial API contract.
    return publicJob(job);
  })();
  pendingJobByScene.set(key, createJob);
  try {
    return await createJob;
  } finally {
    if (pendingJobByScene.get(key) === createJob) pendingJobByScene.delete(key);
  }
}

/**
 * Retrieves the public status descriptor for an existing fal.ai video automation job.
 *
 * @param {string} loomId - The ID of the parent loom story.
 * @param {string} episodeId - The ID of the episode containing the scene.
 * @param {string} nodeId - The ID of the scene node.
 * @param {string} jobId - The unique job ID.
 * @returns {object} Public job status descriptor.
 * @throws {ServerError} When the job is not found or does not match scene scope.
 */
export function getFalVideoAutomation(loomId, episodeId, nodeId, jobId) {
  pruneJobs();
  const job = jobs.get(jobId);
  if (!job || job.loomId !== loomId || job.episodeId !== episodeId || job.nodeId !== nodeId) {
    throw new ServerError('fal.ai scene video job not found', { status: 404, code: 'NOT_FOUND' });
  }
  return publicJob(job);
}

/**
 * Resets all in-memory fal.ai video automation job queues, caches, and run promises (test helper).
 */
export function _resetFalVideoAutomations() {
  jobs.clear();
  latestJobByScene.clear();
  pendingJobByScene.clear();
  runTail = Promise.resolve();
}
