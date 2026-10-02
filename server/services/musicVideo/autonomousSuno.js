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
 *     the song and fetching the audio — happens over HTTP against the CDN, so a
 *     redesigned player or download menu cannot break it.
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
import { ServerError } from '../../lib/errorHandler.js';
import { sunoAudioUrl, sunoSongIdsFromHrefs, sunoSongUrl } from '../../lib/musicVideoAutonomous.js';
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

/**
 * Wait for a song's audio to be fetchable and fully written, then return its
 * bytes. "Fully written" = a 200 whose size is at least MIN_AUDIO_BYTES and
 * unchanged across two polls (Suno streams a partial file while it renders).
 */
async function downloadSunoAudio(songId, {
  fetchImpl = fetch, sleep = defaultSleep, timeoutMs = SUNO_AUDIO_TIMEOUT_MS, intervalMs = SUNO_POLL_INTERVAL_MS, now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastSize = -1;
  for (;;) {
    const res = await fetchImpl(sunoAudioUrl(songId)).catch(() => null);
    if (res?.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length >= MIN_AUDIO_BYTES && bytes.length === lastSize) return bytes;
      lastSize = bytes.length;
    }
    if (now() + intervalMs > deadline) {
      throw new ServerError(`Suno: the song ${songId} did not finish rendering in time`, {
        status: 504, code: 'SUNO_AUDIO_TIMEOUT', context: { platform: LABEL, songId, url: sunoSongUrl(songId) },
      });
    }
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
    await writeFile(tmp, bytes);
    return importUploadedTrack(tmp, 'song.mp3').finally(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
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
  console.log(`🎵 Suno song ${songId.slice(0, 8)} imported as ${filename} (${Math.round(sizeBytes / 1024)} KB)`);
  return { songId, songIds, filename, sizeBytes };
}

export const __testing = { submitSunoSong, downloadSunoAudio };
