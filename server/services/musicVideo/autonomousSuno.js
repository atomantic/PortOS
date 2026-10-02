/**
 * Generate a Suno song in the signed-in PortOS Browser, export only M4A
 * through its Download UI, validate the completed file, and import it directly.
 * Retries reuse submitted song ids so a failed export never repeats Create.
 */
import { mkdtemp, open, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sunoSongIdsFromHrefs, sunoSongUrl } from '../../lib/musicVideoAutonomous.js';
import { sleep as defaultSleep } from '../../lib/fileCore.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, connectPortosBrowser, loginRequired, serializeBrowserOperation as serialize, step } from './publish/browser.js';

const LABEL = 'Suno';
const SUNO_CREATE_URL = 'https://suno.com/create';
const SUNO_AUDIO_TIMEOUT_MS = 10 * 60 * 1000;

const songLinks = (page, title = null) => page.evaluate((wantedTitle) => [...document.querySelectorAll('a[href*="/song/"]')]
  // Workspace rows may finish loading after Create. A newly seen href alone
  // is not evidence that this request produced the song.
  .filter((a) => wantedTitle === null || a.textContent.trim() === wantedTitle)
  .map((a) => a.getAttribute('href')), title);

// Observe only this click's bounded network metadata. A Suno POST may be
// analytics rather than generation: neither its presence nor a 2xx proves
// acceptance. Never export URLs, headers, bodies, request errors or account data.
function observeSunoPosts(page) {
  const posts = new Map();
  let truncated = false;
  const request = (req) => {
    if (req.method() !== 'POST' || !['xhr', 'fetch'].includes(req.resourceType())) return;
    const host = new URL(req.url()).hostname;
    if (!['suno.com', 'suno.ai'].some((domain) => host === domain || host.endsWith(`.${domain}`))) return;
    if (posts.size >= 16) { truncated = true; return; }
    posts.set(req, { status: null, failed: false });
  };
  const response = (res) => {
    const post = posts.get(res.request());
    if (post) post.status = res.status();
  };
  const failed = (req) => {
    const post = posts.get(req);
    if (post) post.failed = true;
  };
  page.on('request', request);
  page.on('response', response);
  page.on('requestfailed', failed);
  return {
    snapshot: () => ({
      scope: 'suno-fetch-posts',
      observedPosts: posts.size,
      httpStatuses: [...new Set([...posts.values()].map((post) => post.status).filter((status) => status !== null))].sort((a, b) => a - b),
      failedPosts: [...posts.values()].filter((post) => post.failed).length,
      pendingPosts: [...posts.values()].filter((post) => post.status === null && !post.failed).length,
      truncated,
    }),
    stop: () => {
      page.off('request', request);
      page.off('response', response);
      page.off('requestfailed', failed);
      posts.clear();
    },
  };
}

async function sunoRefusalSignals(page) {
  return page.evaluate(() => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const text = [...document.querySelectorAll('[role="dialog"],[role="alert"]')]
      .filter(visible).map((el) => el.textContent.toLowerCase()).join(' ');
    // Return fixed signal names only, never the page's private text.
    return {
      inspected: true,
      captcha: [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenge"]')].some(visible),
      credits: /not enough credits|insufficient credits|out of credits/.test(text),
      signIn: /sign in|log in/.test(text),
      contentPolicy: /content policy|moderation|copyright/.test(text),
    };
  }).catch(() => ({ inspected: false }));
}

/**
 * Fill Suno's custom-song form and press Create. Returns the ids of the songs
 * that appeared (Suno makes two takes per request) — the links present before
 * the click are excluded, so an older song in the workspace is never mistaken
 * for ours.
 */
async function submitSunoSong(page, fields, { sleep = defaultSleep, now = Date.now, signal } = {}) {
  signal?.throwIfAborted();
  await step(LABEL, 'open the create page', () => page.goto(SUNO_CREATE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: T }).catch(() => {});
  // A signed-out visitor is bounced to a sign-in page or sees no create form.
  const url = typeof page.url === 'function' ? page.url() : '';
  const hasForm = await page.locator('textarea').count();
  if (/sign-?in|login|accounts\./i.test(url) || !hasForm) throw loginRequired(LABEL, SUNO_CREATE_URL);

  await step(LABEL, 'switch to custom mode', async () => {
    // Current Suno calls custom mode Advanced and exposes it as a tab.
    // Keep the former Custom button for installations seeing the older UI.
    const advanced = page.getByRole('tab', { name: /^advanced$/i });
    const custom = page.getByRole('button', { name: /^custom$/i });
    if (await advanced.count()) await advanced.first().click({ timeout: T });
    else if (await custom.count()) await custom.first().click({ timeout: T });
  });
  await step(LABEL, 'fill the lyrics', async () => {
    const box = page.locator('[role="textbox"][aria-label="Lyrics editor"],textarea[placeholder*="lyrics" i]').first();
    // Clear stored lyrics too: a previous form draft must not turn an
    // instrumental request into a vocal song.
    await box.fill(fields.instrumental ? '' : fields.lyrics || '', { timeout: T });
  });
  await step(LABEL, 'fill the style', async () => {
    // Advanced's Styles textarea uses rotating style examples as its
    // placeholder. Cowriter, Speech and Sounds are separate editors.
    const modern = await page.locator('[role="textbox"][aria-label="Lyrics editor"]').count();
    const styles = modern ? page.locator('textarea:not([aria-label]):not([placeholder="Describe the sound you want"])') : page.locator('textarea[placeholder*="style" i]');
    await styles.first().fill(fields.style, { timeout: T });
  });
  await step(LABEL, 'fill the title', async () => {
    const title = page.locator('input[placeholder*="title" i]:visible').first();
    if (await title.count()) await title.fill(fields.title, { timeout: T });
  });
  if (fields.instrumental) {
    await step(LABEL, 'turn instrumental on', async () => {
      const instrumental = page.getByRole('button', { name: /^instrumental$/i });
      // Advanced uses an empty lyrics editor for instrumental music.
      if (await instrumental.count()) await instrumental.first().click({ timeout: T });
    });
  }

  const before = new Set(sunoSongIdsFromHrefs(await songLinks(page)));
  const observer = observeSunoPosts(page);
  try {
    await step(LABEL, 'press Create', async () => {
      signal?.throwIfAborted();
      await page.getByRole('button', { name: /^create( song)?$/i }).last().click({ timeout: T });
    });

    // New rows land at the top of the workspace list once Suno accepts the request.
    const deadline = now() + 90_000;
    while (now() < deadline) {
      await sleep(3000);
      const fresh = sunoSongIdsFromHrefs(await songLinks(page, fields.title)).filter((id) => !before.has(id));
      if (fresh.length) return fresh;
    }
    const network = observer.snapshot();
    const refusalSignals = await sunoRefusalSignals(page);
    const observed = network.observedPosts
      ? `${network.observedPosts} Suno POST request(s) observed; HTTP statuses: ${network.httpStatuses.join(', ') || 'none'}`
      : 'no Suno POST request observed';
    const signals = ['captcha', 'credits', 'signIn', 'contentPolicy'].filter((key) => refusalSignals[key]);
    const ui = refusalSignals.inspected ? `visible refusal signals: ${signals.join(', ') || 'none'}` : 'refusal inspection unavailable';
    throw new ServerError(`Suno: no matching song appeared after pressing Create (${observed}; failed: ${network.failedPosts}; pending: ${network.pendingPosts}${network.truncated ? '; sample capped' : ''}; ${ui}). Request metadata does not prove generation acceptance.`, {
      status: 502, code: 'SUNO_NO_SONG', context: { platform: LABEL, network, refusalSignals },
    });
  } finally {
    observer.stop();
  }
}

// Container metadata cannot prove audio frames are complete and decodable.
// Preserve the strict decoder boundary from the former CDN adapter, now using
// the completed browser download and accepting Suno's AAC or Opus M4A output.
async function validateSunoAudio(path, { signal, timeoutMs }) {
  const file = await open(path, 'r');
  const header = Buffer.alloc(12);
  const { bytesRead } = await file.read(header, 0, header.length, 0).finally(() => file.close());
  if (bytesRead !== 12 || header.toString('ascii', 4, 8) !== 'ftyp') return false;
  const { findFfmpeg } = await import('../../lib/ffmpeg.js');
  const bin = await findFfmpeg();
  if (!bin) throw new ServerError('Suno: audio validation requires ffmpeg', {
    status: 503, code: 'SUNO_AUDIO_VALIDATION_UNAVAILABLE', context: { platform: LABEL },
  });
  signal.throwIfAborted();
  try {
    // Decode every frame without transcoding the source. Restrict both the
    // protocol and demuxer: a downloaded playlist cannot initiate network I/O.
    const { stdout } = await promisify(execFile)(bin, [
      '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
      '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', path,
      '-map', '0:a:0', '-progress', 'pipe:1', '-stats_period', '600', '-f', 'null', '-',
    ], safeChildProcessOptions({ signal, timeout: Math.min(timeoutMs, 15_000), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }));
    if (![...stdout.matchAll(/^out_time_us=(\d+)$/gm)].some((match) => Number(match[1]) > 0)) {
      throw new Error('No decoded audio frames');
    }
    return true;
  } catch {
    if (signal.aborted) throw signal.reason;
    // Raw decoder output contains local paths and must not enter diagnostics.
    throw new ServerError('Suno: downloaded content is not decodable audio', {
      status: 502, code: 'SUNO_AUDIO_INVALID', context: { platform: LABEL, reason: 'decode_failed' },
    });
  }
}

/** One bounded export, including waiting for the browser to finish saving. */
async function downloadSunoAudio(page, songId, path, {
  timeoutMs = SUNO_AUDIO_TIMEOUT_MS, signal, validateAudio = validateSunoAudio,
} = {}) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let download;
  let stage = 'open-song';
  let stopped;
  let rejectStop;
  const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
  // The operation may already be cancelled before its first await.
  stopPromise.catch(() => {});
  const error = (code, reason, status = 502) => new ServerError(`Suno: M4A export ${reason}`, {
    status, code, context: { platform: LABEL, stage, reason },
  });
  const stop = (err) => {
    if (stopped) return;
    stopped = err;
    controller.abort();
    rejectStop(err);
    // Don't await an unresponsive browser during cancellation.
    download?.cancel().catch(() => {});
  };
  const abort = () => stop(error('SUNO_AUDIO_CANCELLED', 'cancelled', 499));
  const timer = setTimeout(() => stop(error('SUNO_AUDIO_TIMEOUT', 'deadline-exceeded', 504)), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const bounded = async (name, fn) => {
    stage = name;
    if (stopped) throw stopped;
    return Promise.race([Promise.resolve().then(fn), stopPromise]);
  };
  let onDownload;
  try {
    await bounded('open-song', () => page.goto(sunoSongUrl(songId), { waitUntil: 'domcontentloaded', timeout: remaining() }));
    if (/sign-?in|login|accounts\./i.test(page.url())) throw loginRequired(LABEL, SUNO_CREATE_URL);
    await bounded('open-options', () => page.getByRole('button', { name: 'More options', exact: true }).first().click({ timeout: remaining() }));
    await bounded('open-download', () => page.getByRole('menuitem', { name: 'Download', exact: true }).click({ timeout: remaining() }));
    for (const name of ['M4A', 'MP3', 'WAV', 'MP4 video asset']) {
      const button = page.getByRole('button', { name, exact: true });
      const selected = await bounded('select-m4a', () => button.evaluate((el) => el.classList.contains('bg-foreground-primary') && el.classList.contains('text-background-primary')));
      if (selected !== (name === 'M4A')) await bounded('select-m4a', () => button.click({ timeout: remaining() }));
    }
    // Fail closed if Suno changes selection behavior: never unlock an export
    // while another format remains selected or M4A failed to become selected.
    for (const name of ['M4A', 'MP3', 'WAV', 'MP4 video asset']) {
      const selected = await bounded('verify-m4a', () => page.getByRole('button', { name, exact: true }).evaluate((el) => el.classList.contains('bg-foreground-primary') && el.classList.contains('text-background-primary')));
      if (selected !== (name === 'M4A')) throw error('SUNO_AUDIO_DOWNLOAD_FAILED', 'format-selection-failed');
    }
    // Register before clicking; a completed export can emit immediately. Own
    // the listener so timeout/cancellation can remove it without waiting for a
    // second Playwright timeout. Never repeat an Unlock & Download click.
    const started = new Promise((resolve) => {
      onDownload = (value) => { download = value; resolve(value); };
      page.once('download', onDownload);
    });
    await bounded('start-download', () => page.getByRole('button', { name: /^(Unlock & Download|Download)$/ }).click({ timeout: remaining() }));
    await bounded('wait-download', () => started);
    await bounded('save-download', () => download.saveAs(path));
    if (await bounded('check-download', () => download.failure())) throw error('SUNO_AUDIO_DOWNLOAD_FAILED', 'browser-download-failed');
    if (!await bounded('validate-audio', () => validateAudio(path, { signal: controller.signal, timeoutMs: remaining() }))) throw error('SUNO_AUDIO_INVALID', 'invalid-audio');
  } catch (err) {
    if (err instanceof ServerError) throw err;
    // Playwright and ffprobe errors may contain user paths, URLs or page text.
    throw error('SUNO_AUDIO_DOWNLOAD_FAILED', 'export-failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (onDownload) page.off('download', onDownload);
    // The page owner closes it before removing the staging directory. Cancel
    // also stops pending saveAs work; browser artifact deletion is best effort.
    if (download) {
      download.cancel().catch(() => {});
      download.delete().catch(() => {});
    }
  }
}

// A dead CDP connection must not turn an already timed-out export into an
// unbounded cleanup wait. Close the tab before disconnecting. Cancellation of
// an already dispatched browser action is best effort if CDP is unresponsive;
// we never retry that click, and an aborted operation can never import audio.
async function closeSunoBrowser(page, browser) {
  for (const close of [() => page?.close(), () => browser.close()]) {
    let timer;
    await Promise.race([
      Promise.resolve().then(close).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 500); }),
    ]).finally(() => clearTimeout(timer));
  }
}

/** Generate (or resume) a song and import its completed, validated M4A. */
export async function generateSunoSong(fields, deps = {}) {
  const connect = deps.connect || connectPortosBrowser;
  const importAudio = deps.importAudio || (async (path, name) => {
    const { importUploadedTrack } = await import('../pipeline/musicLibrary.js');
    return importUploadedTrack(path, name);
  });
  const dir = await mkdtemp(join(tmpdir(), 'portos-suno-'));
  const path = join(dir, 'song.m4a');
  try {
    const songIds = await serialize(async () => {
      deps.signal?.throwIfAborted();
      const { browser, context } = await connect();
      let page;
      try {
        page = await context.newPage();
        const ids = deps.songIds?.length ? deps.songIds : await submitSunoSong(page, fields, deps);
        if (!deps.songIds?.length) await deps.onSubmitted?.(ids);
        await downloadSunoAudio(page, ids[0], path, deps);
        return ids;
      } finally {
        await closeSunoBrowser(page, browser); // disconnect; keep the shared browser running
      }
    });
    deps.signal?.throwIfAborted();
    const { filename, sizeBytes } = await importAudio(path, 'song.m4a');
    return { songId: songIds[0], songIds, filename, sizeBytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const __testing = { submitSunoSong, downloadSunoAudio };
