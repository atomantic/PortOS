/**
 * YouTube watch-history ingestion (#2153) — CDP scrape of the signed-in
 * `youtube.com/feed/history` page via the managed portos-browser profile, feeding
 * the machine-local human-activity timeline (#2150) with `media.watch` events.
 *
 * Why a scrape: YouTube retired the watch-history API years ago. The reliable
 * historical path is the Takeout backfill (youtubeImport.js); this scrape keeps
 * the timeline fresh between backfills by reading the same page a human sees.
 *
 * Design constraints (docs/plans/2026-07-04-human-activity-tracking.md + #2153):
 *
 * - **Conservative cadence.** The history page only shows DAY-bucketed entries
 *   (no per-watch clock time), so polling more than a few times a day buys
 *   nothing. The scheduler (youtubeScheduler.js) defaults to every 8h. Be a polite
 *   scraper.
 * - **Day-bucket dedupe, shared with Takeout.** `dedupeKey = yt:<videoId>:<localDay>`
 *   so a scrape and a Takeout import of the same watch reconcile via
 *   `recordEvents`'s `ON CONFLICT DO NOTHING`. `happenedAt` is the day's local
 *   midnight (the finest the page offers); Takeout supplies the exact instant.
 * - **Machine-local.** The scrape runs against the local browser profile; the
 *   cursor/last-status lives in `data/youtube/` (per-machine, unsynced). Events
 *   land in the machine-local `human_activity_events` table.
 * - **Fragility → surfaced status, never a crash.** Selector failures / signed-out
 *   redirects degrade to a `lastResult` status the settings UI renders, exactly
 *   like message-account `lastSyncStatus`. All selectors live in one place
 *   (`YOUTUBE_SELECTORS`) for easy repair.
 * - **LLM-free.** Extraction is deterministic DOM reading; no AI-provider calls.
 *
 * The pure mappers (video-id parse, day-label resolution, candidate mapping) are
 * exported and unit-tested against saved DOM-shaped fixtures — no browser or DB.
 */
import { dataPath, ensureDir, atomicWrite, tryReadFile, safeJSONParse, sleep } from '../lib/fileUtils.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';
import { getSettings } from './settings.js';
import { findOrOpenPage, listCdpPages, isAuthPage, evaluateOnPage } from './browserService.js';
import { localDayRangeUtc, shortSummary } from './humanActivity.js';
import { youtubeVideoIdFromUrl } from './youtubeImport.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_URL = 'https://www.youtube.com/feed/history';

const STATE_FILE = 'sync-state.json';

// OFF by default — the user logs into YouTube in the managed browser and opts in
// from Settings. 480 min = every 8h ≈ 3 scrapes/day (the page is day-bucketed).
const DEFAULT_CONFIG = { enabled: false, intervalMinutes: 480 };

// Post-navigation settle + bounded lazy-load scroll — the history feed hydrates
// client-side and appends more rows as you scroll.
const NAV_SETTLE_MS = 3500;
const MAX_ENTRIES = 200;

// Every CSS selector the scrape depends on, in ONE place so a YouTube DOM change
// is a single-file repair. Consumed by the in-page extraction script below.
export const YOUTUBE_SELECTORS = {
  section: 'ytd-item-section-renderer',
  sectionHeader: '#header #title, ytd-item-section-header-renderer #title, #title.ytd-item-section-header-renderer',
  videoRenderer: 'ytd-video-renderer, ytd-grid-video-renderer',
  videoTitle: 'a#video-title, #video-title-link, a#video-title-link',
  channelLink: 'ytd-channel-name a, #channel-name a, #text-container.ytd-channel-name a',
  signedOut: 'a[href*="accounts.google.com/ServiceLogin"], a[href*="/ServiceLogin"], ytd-button-renderer a[href*="ServiceLogin"]',
  signedIn: '#avatar-btn, button#avatar-btn, #masthead #avatar, ytd-topbar-menu-button-renderer #avatar',
};

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no filesystem, no DB).
// ---------------------------------------------------------------------------

// Shift a YYYY-MM-DD string by whole days using UTC calendar math (independent of
// any timezone — we're only manipulating the date label, not an instant).
function shiftDayStr(dayStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ''));
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Resolve a YouTube history section-header label to a YYYY-MM-DD local-day
 * string, or null if it can't be parsed. Handles the relative labels YouTube
 * shows ("Today", "Yesterday") against the user's `today` (in their timezone),
 * plus absolute dates ("Jan 5, 2024", "Nov 12"). A yearless date is assigned the
 * current year, rolling back a year if that would land in the future.
 */
export function resolveHistoryDay(label, today) {
  const raw = String(label || '').trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;
  const lower = raw.toLowerCase();
  if (lower === 'today') return today;
  if (lower === 'yesterday') return shiftDayStr(today, -1);

  const m = /([A-Za-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(raw);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = Number(m[2]);
  if (!month || !(day >= 1 && day <= 31)) return null;
  let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  let dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Yearless label that resolves after today → it's from last year.
  if (!m[3] && dayStr > today) {
    year -= 1;
    dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return dayStr;
}

/**
 * Map ONE scraped history entry to a `media.watch` candidate, or null when it
 * lacks a resolvable video id or day bucket. `entry` = { title, url, channel,
 * channelUrl, dayLabel }. `today` (the user's local today, YYYY-MM-DD) anchors
 * relative day labels; `timezone` anchors the local-midnight `happenedAt`.
 *
 * The history page carries no clock time, so `happenedAt` is the local midnight
 * of the bucketed day and the dedupe key is day-scoped — identical to what a
 * Takeout import produces for the same watch, so the two paths reconcile.
 */
export function youtubeWatchCandidate(entry, { today, timezone } = {}) {
  const videoId = youtubeVideoIdFromUrl(entry?.url);
  if (!videoId) return null;
  const dayStr = resolveHistoryDay(entry?.dayLabel, today);
  if (!dayStr) return null;
  const range = localDayRangeUtc(dayStr, timezone);
  if (!range) return null;

  const title = String(entry?.title || '').trim() || '(untitled video)';
  const channel = entry?.channel ? String(entry.channel).trim() : null;
  const channelUrl = entry?.channelUrl ? String(entry.channelUrl).trim() : null;

  return {
    source: 'youtube',
    kind: 'media.watch',
    happenedAt: range.start.toISOString(),
    title,
    summary: channel ? shortSummary(channel) : null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    dedupeKey: `yt:${videoId}:${dayStr}`,
    metadata: {
      videoId,
      channel,
      channelUrl,
      dayBucket: dayStr,
      scraped: true,
    },
  };
}

export function youtubeWatchCandidates(entries = [], ctx = {}) {
  return (entries || []).map((e) => youtubeWatchCandidate(e, ctx)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// In-page extraction script (runs in the browser via CDP Runtime.evaluate).
// Built from YOUTUBE_SELECTORS so selector repair stays single-source.
// ---------------------------------------------------------------------------

function buildExtractionScript() {
  const S = YOUTUBE_SELECTORS;
  return `
    (async function () {
      const S = ${JSON.stringify(S)};
      const MAX = ${MAX_ENTRIES};
      const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return href || null; } };

      // Signed-out gate: the feed shows a ServiceLogin CTA and no avatar.
      const signedOut = !!document.querySelector(S.signedOut) && !document.querySelector(S.signedIn);
      if (signedOut) return { signedOut: true, entries: [] };

      const collect = () => {
        const out = [];
        for (const section of document.querySelectorAll(S.section)) {
          const header = section.querySelector(S.sectionHeader);
          const dayLabel = (header?.textContent || '').trim();
          for (const v of section.querySelectorAll(S.videoRenderer)) {
            const titleEl = v.querySelector(S.videoTitle);
            if (!titleEl) continue;
            const url = abs(titleEl.getAttribute('href'));
            const title = (titleEl.getAttribute('title') || titleEl.textContent || '').trim();
            const chEl = v.querySelector(S.channelLink);
            out.push({
              title,
              url,
              channel: (chEl?.textContent || '').trim() || null,
              channelUrl: chEl ? abs(chEl.getAttribute('href')) : null,
              dayLabel,
            });
          }
        }
        return out;
      };

      // Bounded lazy-load scroll — the feed appends rows as you scroll.
      let entries = collect();
      let stagnant = 0;
      for (let i = 0; i < 12 && entries.length < MAX && stagnant < 3; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((r) => setTimeout(r, 700));
        const next = collect();
        if (next.length <= entries.length) stagnant++; else stagnant = 0;
        entries = next;
      }
      window.scrollTo(0, 0);
      return { signedOut: false, entries: entries.slice(0, MAX) };
    })()
  `;
}

// ---------------------------------------------------------------------------
// Config + machine-local sync state
// ---------------------------------------------------------------------------

export async function getYoutubeConfig() {
  const settings = await getSettings().catch(() => ({}));
  const c = settings?.youtube || {};
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_CONFIG.enabled,
    intervalMinutes: Number.isFinite(c.intervalMinutes) && c.intervalMinutes >= 1
      ? Math.floor(c.intervalMinutes)
      : DEFAULT_CONFIG.intervalMinutes,
  };
}

function stateFilePath() {
  return dataPath('youtube', STATE_FILE);
}

// Machine-local last-run status. NOT federated — it references the local browser
// profile and machine-local activity rows.
export async function readSyncState() {
  const raw = await tryReadFile(stateFilePath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  return {
    lastRunAt: parsed?.lastRunAt || null,
    lastResult: parsed?.lastResult || null,
  };
}

async function writeSyncState(state) {
  await ensureDir(dataPath('youtube'));
  await atomicWrite(stateFilePath(), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Browser helpers (side-effecting — CDP). Never throw to the caller: a scrape
// failure returns a status report the UI renders (mirrors message lastSyncStatus).
// ---------------------------------------------------------------------------

// Ensure the managed browser has the history page loaded and return the CDP page
// object, or a { status } report when it can't. If a YouTube tab is open on a
// different path, navigate it to the history feed in place (CDP re-attaches to
// the same target after navigation) rather than piling up tabs.
async function ensureHistoryPage() {
  let page = await findOrOpenPage(HISTORY_URL).catch(() => null);
  if (!page) return { page: null, status: 'no-browser' };
  if (isAuthPage(page)) return { page: null, status: 'auth-required' };

  if (!/\/feed\/history/.test(page.url || '')) {
    await evaluateOnPage(page, `location.assign(${JSON.stringify(HISTORY_URL)}); true`);
    await sleep(NAV_SETTLE_MS);
    const refreshed = (await listCdpPages().catch(() => [])).find((p) => p.id === page.id);
    if (refreshed) page = refreshed;
  } else {
    await sleep(NAV_SETTLE_MS);
  }
  if (isAuthPage(page)) return { page: null, status: 'auth-required' };
  return { page, status: 'ok' };
}

// ---------------------------------------------------------------------------
// Setup check (settings UI) — is the managed browser up and signed into YouTube?
// ---------------------------------------------------------------------------

const SIGNED_OUT_REMEDIATION = 'Open the managed browser (Browser page) and log into YouTube, then re-run the setup check.';
const NO_BROWSER_REMEDIATION = 'Start the managed browser (Browser page → Launch) so PortOS can read your YouTube history, then re-run the setup check.';

export async function checkSetup() {
  const page = await findOrOpenPage(HISTORY_URL).catch(() => null);
  if (!page) {
    return { ok: false, browserRunning: false, signedIn: false, error: 'Managed browser is not running', remediation: NO_BROWSER_REMEDIATION };
  }
  if (isAuthPage(page)) {
    return { ok: false, browserRunning: true, signedIn: false, error: 'Signed out of YouTube', remediation: SIGNED_OUT_REMEDIATION };
  }
  const S = YOUTUBE_SELECTORS;
  const probe = await evaluateOnPage(page, `
    (function () {
      const S = ${JSON.stringify(S)};
      return {
        signedIn: !!document.querySelector(S.signedIn),
        signedOut: !!document.querySelector(S.signedOut),
        url: location.href,
      };
    })()
  `);
  if (!probe) {
    return { ok: false, browserRunning: true, signedIn: false, error: 'Could not read the YouTube page', remediation: SIGNED_OUT_REMEDIATION };
  }
  const signedIn = Boolean(probe.signedIn) && !probe.signedOut;
  return signedIn
    ? { ok: true, browserRunning: true, signedIn: true }
    : { ok: false, browserRunning: true, signedIn: false, error: 'Signed out of YouTube', remediation: SIGNED_OUT_REMEDIATION };
}

// ---------------------------------------------------------------------------
// Sync (side-effecting — CDP + DB). Runs outside the request lifecycle
// (scheduler / explicit endpoint), so failures return a status report, not throw.
// ---------------------------------------------------------------------------

// Re-entrancy guard: a manual "Sync now" overlapping a scheduler tick would
// scrape the same page twice (deduped, but wasteful). Concurrent callers share
// the in-flight pass.
let syncInFlight = null;
export async function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doRunSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doRunSync() {
  const started = Date.now();
  const { page, status } = await ensureHistoryPage();
  if (!page) {
    const result = status === 'no-browser'
      ? { ok: false, status, error: 'Managed browser is not running', remediation: NO_BROWSER_REMEDIATION }
      : { ok: false, status: 'auth-required', needsAuth: true, error: 'Signed out of YouTube', remediation: SIGNED_OUT_REMEDIATION };
    await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
    console.log(`📺 YouTube sync: ${result.error}`);
    return result;
  }

  const extracted = await evaluateOnPage(page, buildExtractionScript()).catch(() => null);
  if (!extracted || !Array.isArray(extracted.entries)) {
    const result = { ok: false, status: 'extraction-failed', error: 'Could not extract history entries — the page layout may have changed (selectors need repair)' };
    await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
    console.error(`📺 YouTube sync: extraction failed — selectors may need repair`);
    return result;
  }
  if (extracted.signedOut) {
    const result = { ok: false, status: 'auth-required', needsAuth: true, error: 'Signed out of YouTube', remediation: SIGNED_OUT_REMEDIATION };
    await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
    console.log(`📺 YouTube sync: signed out of YouTube`);
    return result;
  }

  const timezone = await getUserTimezone();
  const today = todayInTimezone(timezone);
  const candidates = youtubeWatchCandidates(extracted.entries, { today, timezone });

  let persistFailed = false;
  const { recordEvents } = await import('./humanActivity.js');
  const recordResult = await recordEvents(candidates).catch((err) => {
    console.error(`❌ YouTube activity record failed: ${err?.message || err}`);
    persistFailed = true;
    return { recorded: 0, skipped: candidates.length };
  });

  // Incrementally refresh observed twin evidence when new watches landed (#2156).
  // LLM-free + self-guarded — never blocks or fails the sync.
  if (!persistFailed && recordResult.recorded > 0) {
    const { refreshTwinEvidenceAfterSync } = await import('./twinEnrichment.js');
    await refreshTwinEvidenceAfterSync();
  }

  const result = {
    ok: !persistFailed,
    status: persistFailed ? 'persist-failed' : 'ok',
    ...(persistFailed ? { error: 'Persistence failed — re-run to retry (dedupe makes it safe)' } : {}),
    scanned: extracted.entries.length,
    mapped: candidates.length,
    recorded: recordResult.recorded,
    skipped: recordResult.skipped,
    durationMs: Date.now() - started,
  };
  await writeSyncState({ lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`📺 YouTube sync: scanned ${result.scanned}, recorded ${result.recorded} watch(es)${persistFailed ? ' — PERSIST FAILED' : ''} in ${result.durationMs}ms`);
  return result;
}

// Status for the settings UI: config + last-run state (no scrape).
export async function getStatus() {
  const [config, state] = await Promise.all([getYoutubeConfig(), readSyncState()]);
  return { config, state };
}
