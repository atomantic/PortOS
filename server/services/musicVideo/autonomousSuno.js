/**
 * Autonomous Music Video — the Suno step.
 *
 * Drives the Suno web UI in the PortOS Browser (the same signed-in profile the
 * publish adapters use; no Suno API or credential is involved) to make one song
 * from generated lyrics + a style line, then downloads the finished audio from
 * Suno's public CDN into the music library and imports it as a Track.
 *
 * Two deliberate choices keep this robust to Suno's UI churn:
 *   - The page is only used to FILL the custom-song form, press Create, and
 *     read back the new `/song/<id>` links. Everything after that — waiting for
 *     audio — happens over HTTP against the CDN. This transport does not yet
 *     provide a verified generation-completion signal; import fails closed.
 *   - Every page interaction goes through `step()`, so a failure names the
 *     control that was missing ("Suno: fill the lyrics (...)") and a signed-out
 *     page is reported as PUBLISH_LOGIN_REQUIRED, which the run surfaces as a
 *     parked "needs you" state rather than a generic failure.
 *
 * `page`, `fetch`, `sleep` and the storage calls are injectable so the whole
 * flow is unit-testable without a browser or the network.
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sunoAudioUrl, sunoSongIdsFromHrefs } from '../../lib/musicVideoAutonomous.js';
import { sleep as defaultSleep } from '../../lib/fileCore.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, connectPortosBrowser, loginRequired, serializeBrowserOperation as serialize, step } from './publish/browser.js';

const LABEL = 'Suno';
const SUNO_CREATE_URL = 'https://suno.com/create';
// How long a generation may take before the run gives up on it, and how often
// the CDN is polled while waiting. Suno finishes a song in roughly a minute or
// two; the cap covers a busy queue.
const SUNO_AUDIO_TIMEOUT_MS = 10 * 60 * 1000;
const SUNO_POLL_INTERVAL_MS = 10 * 1000;
// A real song is megabytes; anything under this is a stub or error body.
const MIN_AUDIO_BYTES = 100 * 1024;

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
async function submitSunoSong(page, fields, { sleep = defaultSleep, now = Date.now } = {}) {
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

// Decoding is a separate boundary from generation completion: a partial MP3
// can decode perfectly. Never expose ffmpeg stderr (it contains local paths).
async function validateSunoAudio(bytes, { signal, timeoutMs }) {
  const { findFfmpeg } = await import('../../lib/ffmpeg.js');
  const bin = await findFfmpeg();
  if (!bin) throw new ServerError('Suno: audio validation requires ffmpeg', {
    status: 503, code: 'SUNO_AUDIO_VALIDATION_UNAVAILABLE', context: { platform: LABEL },
  });
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'portos-suno-validation-'));
  try {
    const file = join(dir, 'candidate.mp3');
    await writeFile(file, bytes, { signal });
    // Force an audio stream and decode the entire candidate; neither MIME nor
    // a readable container header proves that its audio frames are decodable.
    const { stdout } = await promisify(execFile)(bin, [
      '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
      '-protocol_whitelist', 'file', '-format_whitelist', 'mp3,wav', '-i', file,
      '-map', '0:a:0', '-progress', 'pipe:1', '-stats_period', '600', '-f', 'null', '-',
    ], safeChildProcessOptions({ signal, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }));
    if (![...stdout.matchAll(/^out_time_us=(\d+)$/gm)].some((match) => Number(match[1]) > 0)) {
      throw new Error('No decoded audio frames');
    }
    return true;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new ServerError('Suno: downloaded content is not decodable audio', {
      status: 502, code: 'SUNO_AUDIO_INVALID', context: { platform: LABEL, reason: 'decode_failed' },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Stable sizes are only a polling heuristic. The CDN integration currently
 * has no verified completion signal, so its default remains explicitly
 * unknown. A future verified adapter must check this exact song and return
 * 'complete'; playable audio, a duration, or a 200 response are not evidence.
 */
async function downloadSunoAudio(songId, {
  fetchImpl = fetch, sleep = defaultSleep, timeoutMs = SUNO_AUDIO_TIMEOUT_MS, intervalMs = SUNO_POLL_INTERVAL_MS, now = Date.now,
  checkCompletion = async () => 'unknown', validateAudio = validateSunoAudio,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastSize = -1;
  let reason = 'not_available';
  let httpStatus = null;
  const timeout = () => new ServerError('Suno: audio download did not complete within its time budget', {
    status: 504, code: 'SUNO_AUDIO_TIMEOUT', context: { platform: LABEL, reason, httpStatus },
  });
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeout();
    const candidate = await withAbortTimeout(remaining, async (signal) => {
      let res;
      try {
        res = await fetchImpl(sunoAudioUrl(songId), { signal });
        signal.throwIfAborted();
        httpStatus = Number.isInteger(res.status) && res.status >= 100 && res.status <= 599 ? res.status : null;
        if (!res.ok) { reason = 'http_status'; return null; }
        const mime = res.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (mime?.startsWith('text/') || /(?:json|xml|html)/.test(mime || '')) {
          throw new ServerError('Suno: downloaded content is not audio', {
            status: 502, code: 'SUNO_AUDIO_INVALID', context: { platform: LABEL, reason: 'non_audio_content', httpStatus },
          });
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        signal.throwIfAborted();
        const stable = bytes.length >= MIN_AUDIO_BYTES && bytes.length === lastSize;
        lastSize = bytes.length;
        if (!stable) { reason = 'size_unstable'; return null; }
        const valid = await validateAudio(bytes, { signal, timeoutMs: Math.max(1, deadline - now()) });
        signal.throwIfAborted();
        if (valid !== true) throw new ServerError('Suno: downloaded content is not decodable audio', {
          status: 502, code: 'SUNO_AUDIO_INVALID', context: { platform: LABEL, reason: 'decode_failed' },
        });
        const completion = await checkCompletion(songId, { signal });
        signal.throwIfAborted();
        if (completion === 'complete') return bytes;
        if (completion === 'pending') { reason = 'generation_pending'; return null; }
        throw new ServerError('Suno: audio is decodable, but generation completion is unverified; existing song IDs are retained for retry', {
          status: 502, code: 'SUNO_AUDIO_COMPLETION_UNVERIFIED', context: { platform: LABEL, reason: 'completion_unknown' },
        });
      } catch (error) {
        if (signal.aborted) { reason = 'deadline_exceeded'; throw timeout(); }
        if (error instanceof ServerError) throw error;
        reason = 'transport_failed';
        return null;
      } finally {
        // Cancel unconsumed error bodies too. A locked body is owned by the
        // fetch consumer, which receives the same abort signal. Cancellation
        // starts immediately; its acknowledgment cannot extend our deadline.
        if (res?.body && !res.bodyUsed) void res.body.cancel().catch(() => {});
      }
    });
    if (now() >= deadline) throw timeout();
    if (candidate) return candidate;
    if (now() + intervalMs >= deadline) throw timeout();
    await sleep(intervalMs);
  }
}

/**
 * Make one Suno song and import it into the music library.
 *
 * `fields` is the output of `sunoSongFields`. Resolves to
 * `{ songId, songIds, filename, sizeBytes }` — the first take is imported; its
 * sibling take ids are returned so the run can record them.
 */
export async function generateSunoSong(fields, deps = {}) {
  const connect = deps.connect || connectPortosBrowser;
  const importAudio = deps.importAudio || (async (bytes) => {
    const { importUploadedTrack } = await import('../pipeline/musicLibrary.js');
    const dir = await mkdtemp(join(tmpdir(), 'portos-suno-'));
    const tmp = join(dir, 'song.mp3');
    try {
      await writeFile(tmp, bytes);
      return await importUploadedTrack(tmp, 'song.mp3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  // A retry after a failed download reuses the songs already submitted rather
  // than spending more Suno credits on a second generation.
  const songIds = deps.songIds?.length ? deps.songIds : await serialize(async () => {
    const { browser, context } = await connect();
    const page = await context.newPage();
    try {
      const submitted = await submitSunoSong(page, fields, deps);
      await deps.onSubmitted?.(submitted);
      return submitted;
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {}); // disconnects; the PortOS Browser keeps running
    }
  });
  const [songId] = songIds;
  const bytes = await downloadSunoAudio(songId, deps);
  const { filename, sizeBytes } = await importAudio(bytes);
  console.log(`🎵 Suno audio imported (${Math.round(sizeBytes / 1024)} KB)`);
  return { songId, songIds, filename, sizeBytes };
}

export const __testing = { submitSunoSong, downloadSunoAudio };
