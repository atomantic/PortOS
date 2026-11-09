/**
 * Drives Gemini's "Create video" tool at gemini.google.com in the signed-in
 * PortOS Browser: open a new chat in its own tab, turn on the tool, attach the
 * start frame then the references, paste the prompt, send once, wait for the
 * clip, and read its bytes with the tab's own sign-in.
 *
 * The send is the one step that spends the account's video quota, so nothing
 * here ever repeats it. A prompt Gemini may have received fails the job instead.
 *
 * The composer's upload rights dialog is the user's to accept: a render stops
 * and leaves the tab open on it rather than clicking Agree.
 */
import { writeFile } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { sleep } from '../../lib/fileCore.js';
import { connectPortosBrowser, loginRequired, serializeBrowserOperation, step } from '../musicVideo/publish/browser.js';

const LABEL = 'Gemini';
export const GEMINI_APP_URL = 'https://gemini.google.com/app';
const STEP_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const RENDER_POLL_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const CONSENT_TITLE = /Creating content from images and files/i;
// Gemini answers in the chat when it will not render. Only short answers count, so a longer reply quoting these words does not.
const REFUSAL = /\b(limit|can.?t|cannot|couldn.?t|could not|unable|not able|try again|something went wrong|upgrade)\b/i;
const REFUSAL_MAX_CHARS = 600;
// "Something went wrong" can sit there with Stop response still showing and no feedback row
// (seen 2026-11-05), so a refusal is whatever stays put for this many polls, finished or not.
const REFUSAL_STABLE_POLLS = 3;

const fail = (code, message, status = 502, context = {}) => new ServerError(message, { status, code, context });

/** The tab should stay open after this failure: the user has something to do or see there. */
export const geminiWebKeepsTab = (err) => ['GEMINI_WEB_CONSENT_REQUIRED', 'PUBLISH_LOGIN_REQUIRED', 'GEMINI_WEB_TIMEOUT', 'GEMINI_WEB_DOWNLOAD_FAILED'].includes(err?.code);

async function openComposer(page) {
  await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
  if (/accounts\.google\./i.test(page.url())) throw loginRequired(LABEL, GEMINI_APP_URL);
  const editor = page.getByRole('textbox', { name: /Enter a prompt/i });
  await editor.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).catch(async (err) => {
    // A signed-out visitor still gets a composer on some pages, so this only explains a missing one.
    if (await page.getByRole('link', { name: /^Sign in$/i }).count().catch(() => 0)) throw loginRequired(LABEL, GEMINI_APP_URL);
    throw err;
  });
  return editor;
}

async function enableVideoTool(page) {
  const chip = page.getByRole('button', { name: 'Deselect Videos' });
  if (await chip.count()) return;
  await page.getByRole('button', { name: 'Upload & tools' }).click({ timeout: STEP_TIMEOUT_MS });
  await page.getByRole('menuitemcheckbox', { name: 'Create video' }).click({ timeout: STEP_TIMEOUT_MS });
  await chip.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

// The composer keeps the account's last mode, and a Flash-Lite chat has answered a
// Create video request with a still (2026-11-09), so every render picks Flash.
const FLASH_MODE = /^[\d.]*\s*Flash\b(?!-Lite)/i;
async function chooseFlashMode(page) {
  const picker = page.getByRole('button', { name: /^Open mode picker/ });
  const current = await picker.getAttribute('aria-label', { timeout: STEP_TIMEOUT_MS });
  if (/currently Flash\b(?!-Lite)/i.test(current || '')) return;
  await picker.click({ timeout: STEP_TIMEOUT_MS });
  await page.getByRole('menuitemradio', { name: FLASH_MODE }).first().click({ timeout: STEP_TIMEOUT_MS });
}

// Sending without the tool would spend the prompt on an ordinary chat answer.
const assertVideoToolOn = (page) => page.getByRole('button', { name: 'Deselect Videos' })
  .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });

async function chooseAspect(page, choice) {
  const button = page.getByRole('button', { name: /^Aspect ratio/ });
  const current = await button.getAttribute('aria-label', { timeout: STEP_TIMEOUT_MS });
  if (current?.includes(choice)) return;
  await button.click({ timeout: STEP_TIMEOUT_MS });
  await page.getByRole('menuitemradio', { name: choice }).click({ timeout: STEP_TIMEOUT_MS });
}

async function attachFiles(page, files) {
  await page.getByRole('button', { name: 'Upload & tools' }).click({ timeout: STEP_TIMEOUT_MS });
  // Settled from the start: a failed click below closes the page, which rejects this waiter.
  const chooser = page.waitForEvent('filechooser', { timeout: STEP_TIMEOUT_MS }).then((value) => ({ chooser: value }), (error) => ({ error }));
  await page.locator('[data-test-id=local-images-files-uploader-button]').click({ timeout: STEP_TIMEOUT_MS });
  const consent = page.getByRole('dialog').filter({ hasText: CONSENT_TITLE });
  const picked = await Promise.race([
    chooser,
    consent.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }).then(() => ({ consent: true })),
  ]);
  if (picked.consent) {
    throw fail('GEMINI_WEB_CONSENT_REQUIRED', 'Gemini asks you to agree to its upload terms first. Click Agree in the Gemini tab in the PortOS Browser, then render again.', 409);
  }
  if (picked.error) throw picked.error;
  await picked.chooser.setFiles(files);
}

// Attachments are ready when the send control is live: Gemini holds it back while an upload runs.
async function waitForSendReady(page) {
  const send = page.getByRole('button', { name: 'Send message' });
  await send.waitFor({ state: 'visible', timeout: UPLOAD_TIMEOUT_MS });
  const deadline = Date.now() + UPLOAD_TIMEOUT_MS;
  while (await send.getAttribute('aria-disabled') === 'true') {
    if (Date.now() > deadline) throw new Error('the attachments did not finish uploading');
    await sleep(500);
  }
  return send;
}

const readLatestResponse = (page) => page.evaluate(() => {
  const responses = document.querySelectorAll('model-response');
  const latest = responses[responses.length - 1];
  if (!latest) return { responded: false };
  const video = latest.querySelector('video');
  const content = latest.querySelector('model-response-content') || latest;
  return {
    responded: true,
    videoUrl: video?.currentSrc || video?.src || video?.querySelector('source')?.src || null,
    text: (content.innerText || '').trim(),
    image: Boolean(content.querySelector('img')),
    // Gemini shows the feedback row only on a finished answer.
    finished: Boolean(latest.querySelector('message-actions button')),
  };
});

/** Wait for the sent prompt's clip. A short answer with no video that reads as a refusal is reported in Gemini's own words. */
async function waitForClip(page, { deadline, signal, onWait }) {
  let refusal = null;
  let refusalPolls = 0;
  for (;;) {
    if (signal?.aborted) throw fail('GEMINI_WEB_CANCELED', 'Canceled', 499);
    const state = await readLatestResponse(page);
    if (state.videoUrl) return state.videoUrl;
    if (state.finished && state.image) {
      throw fail('GEMINI_WEB_NO_VIDEO', 'Gemini answered with a still image instead of a video. Render again to try once more.', 502);
    }
    const refused = state.responded && state.text.length <= REFUSAL_MAX_CHARS && REFUSAL.test(state.text) ? state.text : null;
    refusalPolls = refused && refused === refusal ? refusalPolls + 1 : 1;
    refusal = refused;
    if (refused && (state.finished || refusalPolls >= REFUSAL_STABLE_POLLS)) {
      throw fail('GEMINI_WEB_REFUSED', `Gemini did not render this clip: ${refused.replace(/^Gemini said\s*/i, '')}`, 502);
    }
    if (Date.now() > deadline) {
      throw fail('GEMINI_WEB_TIMEOUT', 'Gemini did not deliver a video in time. The chat is still open in the PortOS Browser, so it may yet finish there.', 504);
    }
    onWait?.();
    await sleep(RENDER_POLL_MS);
  }
}

async function downloadClip(context, url, outputPath) {
  const response = await context.request.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }).catch((err) => {
    throw fail('GEMINI_WEB_DOWNLOAD_FAILED', `Could not download the clip from Gemini (${err.message.split('\n')[0]}). It is still in the open chat.`);
  });
  const type = response.headers()['content-type'] || '';
  if (!response.ok() || !type.startsWith('video/')) {
    throw fail('GEMINI_WEB_DOWNLOAD_FAILED', `Could not download the clip from Gemini (HTTP ${response.status()}, ${type || 'no type'}). It is still in the open chat.`);
  }
  await writeFile(outputPath, await response.body());
}

/**
 * @param {object} request
 * @param {string} request.prompt sent exactly as given
 * @param {string[]} request.files start frame first, then references
 * @param {string} request.aspectChoice the composer's menu label
 * @param {string} request.outputPath where the clip lands
 * @param {number} request.deadline epoch ms for the whole render
 * @param {AbortSignal} [request.signal]
 * @param {(phase: 'open'|'attach'|'send'|'wait'|'fetch') => void} [request.onPhase]
 * @returns {Promise<{ chatUrl: string }>}
 */
export async function renderOnGeminiWeb({ prompt, files = [], aspectChoice, outputPath, deadline, signal, onPhase, connect = connectPortosBrowser }) {
  const { browser, context } = await connect();
  let page = null;
  let keepTab = false;
  try {
    page = await context.newPage();
    const tab = page;
    // Typing and the file picker go to whichever tab has focus, so the composing steps
    // queue with the other PortOS Browser drivers. The long wait holds nothing.
    await serializeBrowserOperation(async () => {
      if (signal?.aborted) throw fail('GEMINI_WEB_CANCELED', 'Canceled', 499);
      onPhase?.('open');
      const editor = await step(LABEL, 'open a new chat', () => openComposer(tab));
      await step(LABEL, 'choose the Flash mode', () => chooseFlashMode(tab));
      await step(LABEL, 'turn on Create video', () => enableVideoTool(tab));
      await step(LABEL, 'choose the aspect ratio', () => chooseAspect(tab, aspectChoice));
      if (files.length) {
        onPhase?.('attach');
        await step(LABEL, 'attach the images', () => attachFiles(tab, files));
      }
      await step(LABEL, 'enter the prompt', async () => {
        await editor.click({ timeout: STEP_TIMEOUT_MS });
        await tab.keyboard.insertText(prompt);
      });
      const send = await step(LABEL, 'wait for the uploads', () => waitForSendReady(tab));
      await step(LABEL, 'check Create video is still on', () => assertVideoToolOn(tab));
      if (signal?.aborted) throw fail('GEMINI_WEB_CANCELED', 'Canceled', 499);
      onPhase?.('send');
      await step(LABEL, 'send the prompt', () => send.click({ timeout: STEP_TIMEOUT_MS }));
    }, { label: LABEL, status: 'Starting a Gemini video', focus: () => tab.bringToFront() });

    onPhase?.('wait');
    const url = await waitForClip(page, { deadline, signal, onWait: () => onPhase?.('wait') });
    if (signal?.aborted) throw fail('GEMINI_WEB_CANCELED', 'Canceled', 499);
    onPhase?.('fetch');
    await downloadClip(context, url, outputPath);
    return { chatUrl: page.url() };
  } catch (err) {
    keepTab = geminiWebKeepsTab(err);
    throw err;
  } finally {
    if (page && !keepTab) await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
