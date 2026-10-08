/**
 * Generate a Suno song in the signed-in PortOS Browser, export only M4A
 * through its Download UI, validate the completed file, and import it directly.
 * Retries reuse submitted song ids so a failed export never repeats Create.
 */
import { copyFile, mkdtemp, open, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sunoSongIdsFromHrefs, sunoSongUrl } from '../../lib/musicVideoAutonomous.js';
import { escapeRegExp } from '../../lib/textUtils.js';
import { sleep as defaultSleep } from '../../lib/fileCore.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, connectPortosBrowser, loginRequired, serializeBrowserOperation as serialize, step } from './publish/browser.js';

const LABEL = 'Suno';
const SUNO_CREATE_URL = 'https://suno.com/create';
const SUNO_AUDIO_TIMEOUT_MS = 10 * 60 * 1000;
// How long an opened version menu may take to list its items.
const SUNO_MENU_WAIT_MS = 5000;

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

// An older Suno UI may lack one of the Advanced options: skip it, but say so.
const skipped = (control) => console.warn(`⚠️ ${LABEL}: ${control} not found — continuing without it`);

/**
 * The brief's optional Advanced-form controls (model version, exclude styles,
 * vocal gender). Each is a no-op when unset and is skipped with a warning when
 * the page has no such control; none of them blocks the song.
 */
// Suno's option rows ("Vocal Gender", "Max Mode", "Duration") are a label span
// beside a few plain buttons; the chosen one carries the `standard` button
// variant, the rest the `tertiary` one. Clicking the chosen button again may
// toggle it off, so only click when it is not already selected.
const optionRow = (page, label) => page.locator(`div:has(> div > span:text-is("${label}"))`).last();
const isSelected = async (button) => /hxc-btn-variant-standard/.test((await button.getAttribute('class')) || '');
async function chooseInRow(page, label, name) {
  const row = optionRow(page, label);
  if (!await row.count()) return skipped(`the ${label} row`);
  const button = row.getByRole('button', { name });
  if (!await button.count()) return skipped(`the ${label} buttons`);
  if (await isSelected(button.first())) return;
  await button.first().click({ timeout: T });
}

async function setSunoOptions(page, fields) {
  if (fields.model) {
    await step(LABEL, 'choose the model version', async () => {
      // The version picker is the menu button labelled with the current version ("v6").
      const version = page.locator('button[aria-haspopup="menu"]').filter({ hasText: /^\s*v\d/i });
      if (!await version.count()) return skipped('the model version menu');
      const current = (await version.first().innerText({ timeout: T })).trim();
      if (current.toLowerCase() === fields.model.toLowerCase()) return;
      await version.first().click({ timeout: T });
      // Menu entries are radio items whose accessible name starts with the version
      // and goes on with a tier and blurb ("v6 Pro Powerful. Versatile. …",
      // "v6-wild Pro Best for experimental ideas."): match the leading token only.
      const name = new RegExp(`^${escapeRegExp(fields.model)}(\\s|$)`, 'i');
      const item = page.getByRole('menuitemradio', { name }).or(page.getByRole('menuitem', { name }));
      await item.first().waitFor({ state: 'visible', timeout: SUNO_MENU_WAIT_MS }).catch(() => {});
      if (!await item.count()) {
        await page.keyboard.press('Escape');
        return skipped(`model ${fields.model} in the version menu (keeping ${current})`);
      }
      await item.first().click({ timeout: T });
    });
  }
  // Exclude styles, vocal gender and Max Mode sit in the collapsible "More Options" section.
  if (fields.excludeStyles != null || fields.vocalGender || fields.maxMode != null) {
    await step(LABEL, 'open More Options', async () => {
      if (await page.locator('input[placeholder="Exclude styles"]:visible').count()) return;
      const more = page.getByText(/^more options$/i);
      if (!await more.count()) return skipped('the More Options section');
      await more.first().click({ timeout: T });
    });
  }
  // An explicit '' still fills: Suno keeps the previous draft's exclusions.
  if (fields.excludeStyles != null) {
    await step(LABEL, 'fill exclude styles', async () => {
      const exclude = page.locator('input[placeholder="Exclude styles"]');
      if (!await exclude.count()) return skipped('the Exclude styles field');
      await exclude.first().fill(fields.excludeStyles, { timeout: T });
    });
  }
  if (fields.vocalGender) {
    await step(LABEL, 'choose the vocal gender', () => chooseInRow(page, 'Vocal Gender', fields.vocalGender === 'female' ? /^female$/i : /^male$/i));
  }
  if (fields.maxMode != null) {
    await step(LABEL, `turn Max Mode ${fields.maxMode ? 'on' : 'off'}`, () => chooseInRow(page, 'Max Mode', fields.maxMode ? /^on$/i : /^off$/i));
  }
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

  await setSunoOptions(page, fields);

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

const DOWNLOAD_POLL_MS = 1000;
const downloadKey = (file) => `${file.name}\0${file.modified}`;

async function defaultListDownloads() {
  const { getDownloads } = await import('../browserService.js');
  return getDownloads();
}

// The PortOS Browser keeps Chrome's native download manager (see
// browser/server.js), so a CDP-attached Playwright never sees a `download`
// event: the M4A just lands in the profile's download directory. Detect it
// there instead — a new .m4a (Chrome lists a file only after its .crdownload
// rename) whose size held steady across two polls.
async function watchDownloadsDir(listDownloads, baseline, signal, pollMs) {
  let lastSize = null;
  let lastName = null;
  while (!signal.aborted) {
    const { downloadDir, files } = await listDownloads().catch(() => ({ files: [] }));
    const fresh = files.find((f) => /\.m4a$/i.test(f.name) && !baseline.has(downloadKey(f)));
    if (fresh && fresh.name === lastName && fresh.size === lastSize && fresh.size > 0) return join(downloadDir, fresh.name);
    lastName = fresh?.name ?? null;
    lastSize = fresh?.size ?? null;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return null;
}

/** One bounded export, including waiting for the browser to finish saving. */
async function downloadSunoAudio(page, songId, path, {
  timeoutMs = SUNO_AUDIO_TIMEOUT_MS, signal, validateAudio = validateSunoAudio,
  listDownloads = defaultListDownloads, downloadPollMs = DOWNLOAD_POLL_MS, onProgress, onSongPage,
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
  const watch = new AbortController();
  try {
    await bounded('open-song', () => page.goto(sunoSongUrl(songId), { waitUntil: 'domcontentloaded', timeout: remaining() }));
    if (/sign-?in|login|accounts\./i.test(page.url())) throw loginRequired(LABEL, SUNO_CREATE_URL);
    // The signed-in page also carries a private song's title and lyrics; a
    // caller that wants them gets the HTML. Advisory: it never fails the export.
    if (onSongPage) {
      const html = await bounded('read-page', () => page.content()).catch(() => null);
      if (html) { try { onSongPage(html); } catch { /* advisory */ } }
    }
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
    const baseline = new Set((await bounded('snapshot-downloads', () => listDownloads().catch(() => ({ files: [] })))).files.map(downloadKey));
    await bounded('start-download', () => page.getByRole('button', { name: /^(Unlock & Download|Download)$/ }).click({ timeout: remaining() }));
    const landed = await bounded('wait-download', () => Promise.race([
      started.then(() => null),
      watchDownloadsDir(listDownloads, baseline, watch.signal, downloadPollMs),
    ]));
    if (landed) {
      await bounded('save-download', () => copyFile(landed, path));
    } else {
      await bounded('save-download', () => download.saveAs(path));
      if (await bounded('check-download', () => download.failure())) throw error('SUNO_AUDIO_DOWNLOAD_FAILED', 'browser-download-failed');
    }
    onProgress?.('validating');
    if (!await bounded('validate-audio', () => validateAudio(path, { signal: controller.signal, timeoutMs: remaining() }))) throw error('SUNO_AUDIO_INVALID', 'invalid-audio');
  } catch (err) {
    if (err instanceof ServerError) throw err;
    // Playwright and ffprobe errors may contain user paths, URLs or page text.
    throw error('SUNO_AUDIO_DOWNLOAD_FAILED', 'export-failed');
  } finally {
    clearTimeout(timer);
    watch.abort();
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

// Suno returns two renders per request; the second is usually the better one.
// A single-id resume (or a one-render result) falls back to the only id.
const pickRender = (ids) => ids[1] ?? ids[0];

/**
 * Generate (or resume) a song and import its completed, validated M4A.
 * `deps.onProgress(step)` reports the long stage's sub-steps — `opening`,
 * `generating`, `exporting`, `validating`, `importing` — so the run can show
 * where a ten-minute stage is; a throwing reporter never fails the song.
 */
export async function generateSunoSong(fields, deps = {}) {
  const report = (name) => { try { deps.onProgress?.(name); } catch { /* progress is advisory */ } };
  const exportDeps = { ...deps, onProgress: report };
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
      report('opening');
      const { browser, context } = await connect();
      let page;
      try {
        page = await context.newPage();
        if (!deps.songIds?.length) report('generating');
        const ids = deps.songIds?.length ? deps.songIds : await submitSunoSong(page, fields, deps);
        if (!deps.songIds?.length) await deps.onSubmitted?.(ids);
        report('exporting');
        await downloadSunoAudio(page, pickRender(ids), path, exportDeps);
        return ids;
      } finally {
        await closeSunoBrowser(page, browser); // disconnect; keep the shared browser running
      }
    });
    deps.signal?.throwIfAborted();
    report('importing');
    const { filename, sizeBytes } = await importAudio(path, 'song.m4a');
    return { songId: pickRender(songIds), songIds, filename, sizeBytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const __testing = { submitSunoSong, downloadSunoAudio };
