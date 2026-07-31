/**
 * Image Gen — observed quota state for the cloud-CLI backends.
 *
 * The cloud image backends have NO queryable quota surface. Antigravity's
 * `/usage` panel reports only two token groups (`GEMINI MODELS`,
 * `CLAUDE AND GPT MODELS`) — its own footnote says quota is "consumed
 * proportionally to the cost of the tokens" — and the imagen backend that
 * actually renders the pixels is not represented at all. Measured 2026-07-31:
 * `generate_image` returned 429 RESOURCE_EXHAUSTED while the panel showed the
 * Gemini 5-hour group at 78% remaining. The agent model and the image backend
 * are separate buckets, and only one of them is reportable.
 *
 * So this module reports what PortOS can actually observe: it dispatches every
 * cloud image render itself, so it sees the 429 the moment a render hits one,
 * along with the reset time the provider states in its own error text. That is
 * the only honest image-quota signal available — it is derived from real
 * renders, never polled, and costs nothing.
 *
 * Deliberately reports NOTHING it has not observed: an un-blocked backend
 * shows a render count, not a fabricated "100% left" meter, because a quota we
 * cannot query is not a quota we may claim is healthy.
 *
 * Wiring: a single subscriber on the `imageGenEvents` bus, the same shape
 * `mediaAssetIndex` uses for "do something for every finished image" — NOT
 * edits in each provider's finalizer. A new backend that emits on the bus is
 * tracked for free, and the provider suites need no mock of this module.
 *
 * Storage is `ephemeral-file` per docs/STORAGE.md — regenerable runtime
 * telemetry with a hours-long horizon. Deliberately NOT excluded from backup:
 * the file is tiny, and a restored block that no longer applies self-heals on
 * the next successful render.
 */

import { join } from 'path';
import { IMAGE_GEN_MODE, CLOUD_IMAGE_GEN_MODES, IMAGE_TOOL_NAMES } from './imageGen/modes.js';
import { imageGenEvents } from './imageGenEvents.js';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { analyzeError, ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';

const STATE_FILE = () => join(PATHS.data, 'imagegen-quota.json');

// Renders older than this drop out of the rolling activity window.
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Cap the retained render log so a batch run can't grow the file without
// bound. Both bounds do work: a batch can exceed this inside one 24h window.
const MAX_RENDER_SAMPLES = 200;

// Only the cloud CLIs spend remote image quota — local renders run on the
// user's own GPU and external hits their own SD endpoint, so neither has
// anything to report. Keyed off CLOUD_IMAGE_GEN_MODES rather than a second
// hand-maintained list, so a 4th cloud backend is tracked the moment it is
// added there. Labels mirror the client's MODE_LABELS so one backend doesn't
// appear under two names across the UI.
const MODE_LABELS = Object.freeze({
  [IMAGE_GEN_MODE.AGY]: 'Agy',
  [IMAGE_GEN_MODE.GROK]: 'Grok',
  [IMAGE_GEN_MODE.CODEX]: 'Codex',
});

export const isQuotaTrackedImageMode = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode);

const rowLabel = (mode) =>
  `${MODE_LABELS[mode] || mode} · ${IMAGE_TOOL_NAMES[mode] || 'image tool'}`;

// Single tail: two renders finishing together must not interleave their
// read-modify-write on the shared ledger file.
const queueQuotaWrite = createFileWriteQueue();

// No in-memory mirror — the read side runs once per Usage-page load and the
// write side once per render, so re-reading inside the queue (the domainUsage
// convention) is cheaper than a cache plus its invalidation and test hook.
async function readLedger() {
  const { ok, value } = await readJSONFileStrict(STATE_FILE(), null, { logError: false });
  // A failed/corrupt read must not read as "no renders, no block" — that would
  // silently clear a real block and report a fake 0. Surface it to the caller.
  if (!ok) return null;
  return value && typeof value.modes === 'object' && value.modes !== null ? value : { modes: {} };
}

/**
 * Parse an absolute ISO instant out of provider error text.
 * Antigravity phrases it as `(around 2026-07-31T21:38:09Z)`. Pure.
 */
const parseAbsoluteReset = (text) => {
  const m = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

/**
 * Parse a relative reset window (`quota will reset in approximately 5 hours`,
 * `try again in 30 minutes`) into an absolute epoch ms. Pure given `now`.
 */
const parseRelativeReset = (text, now) => {
  const m = text.match(/(?:reset|retry|try again|available)\b[^.]{0,40}?\bin\s+(?:approximately\s+|about\s+|~\s*)?(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?/i);
  if (!m) return null;
  const unitMs = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[m[2].toLowerCase()];
  return now + Number(m[1]) * unitMs;
};

// Image-backend refusals the shared CLI classifier doesn't cover: it keys on
// `API Error: 429` / `rate limit` / `too many requests`, none of which match
// the imagen backend's `429 (Resource Exhausted) ... exhausted your capacity`.
const IMAGE_QUOTA_PATTERNS = [
  /\b429\b/,
  /resource[\s_-]*exhausted/i,
  /exhausted your (?:capacity|quota)/i,
  /quota (?:will reset|exceeded|exhausted)/i,
  /out of (?:quota|credits)/i,
  /insufficient[\s_-]*quota/i,
];

// Categories from the shared classifier that mean "refused for quota reasons".
const QUOTA_CATEGORIES = new Set([
  ERROR_CATEGORIES.RATE_LIMIT,
  ERROR_CATEGORIES.USAGE_LIMIT,
  ERROR_CATEGORIES.QUOTA_EXCEEDED,
]);

/**
 * Classify a failed render's error text. Returns `{ exhausted, resetsAt }`
 * where `resetsAt` is epoch ms or null. Pure given `now`; exported for tests.
 *
 * Layered on purpose: the image-specific patterns catch the backend phrasings
 * measured here, and `analyzeError` folds in every provider phrasing the rest
 * of the toolkit has already learned, so a new one only has to be taught once.
 */
export function parseImageQuotaSignal(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return { exhausted: false, resetsAt: null };
  const exhausted = IMAGE_QUOTA_PATTERNS.some((re) => re.test(s))
    || QUOTA_CATEGORIES.has(analyzeError(s).category);
  if (!exhausted) return { exhausted: false, resetsAt: null };
  // Absolute wins: a provider that states both ("in ~5 hours (around <ISO>)")
  // is more precise in the parenthetical, and it survives a slow error path.
  return { exhausted: true, resetsAt: parseAbsoluteReset(s) ?? parseRelativeReset(s, now) };
}

/**
 * Record the outcome of one cloud image render. Awaits the write, so tests can
 * assert deterministically; the bus subscriber below fires it and forgets.
 */
export async function recordImageGenOutcome({ mode, ok, error = '', at = Date.now() } = {}) {
  if (!isQuotaTrackedImageMode(mode)) return;
  await queueQuotaWrite(async () => {
    const ledger = await readLedger();
    if (!ledger) return; // unreadable ledger — don't overwrite it with a guess
    const entry = ledger.modes[mode] || (ledger.modes[mode] = { renders: [], blockedUntil: null });

    // Epoch ms, not ISO: every read filters this array by a time window, and
    // storing strings means re-parsing each one on every pass.
    entry.renders = [...(entry.renders || []), { at, ok: ok === true }].slice(-MAX_RENDER_SAMPLES);

    if (ok) {
      // A render that succeeded proves the backend is serving again — clear a
      // block that outlived its stated reset (providers round "approximately").
      entry.blockedUntil = null;
    } else {
      const signal = parseImageQuotaSignal(error, { now: at });
      if (signal.exhausted) entry.blockedUntil = signal.resetsAt;
    }
    await atomicWrite(STATE_FILE(), ledger);
  });
}

let subscribed = false;

/**
 * Subscribe the quota recorder to the image-generation bus. Called once at
 * boot from `initMediaJobDependentHooks`. Idempotent.
 *
 * The handlers run outside the request lifecycle (event emitter), so an
 * uncaught throw would crash Node — each dispatch is wrapped, and a telemetry
 * failure must never be able to fail a render.
 */
export function initImageGenQuotaHook() {
  if (subscribed) return;
  const note = (ok) => (payload) => {
    recordImageGenOutcome({ mode: payload?.mode, ok, error: payload?.error })
      .catch((err) => console.error(`❌ Image-gen quota hook: ${err.message}`));
  };
  imageGenEvents.on('completed', note(true));
  imageGenEvents.on('failed', note(false));
  subscribed = true;
}

/** Test-only: allow a suite to re-subscribe against fresh listeners. */
export function __resetImageGenQuotaHookForTests() {
  subscribed = false;
}

/**
 * Build the usage-panel card for image-gen backends, in the same common shape
 * the provider-quota families use.
 *
 * `limits[]` carries ONLY backends observed to be blocked right now — a real
 * meter at 0% left with the provider's own reset time. Everything else is
 * reported as a metric tile, never as an invented percentage.
 *
 * Returns null when no cloud image backend is enabled, so the caller simply
 * renders no card rather than a second "not supported" state.
 *
 * @param {string[]} enabledModes - cloud image modes currently enabled
 */
export async function getImageGenQuota({ enabledModes = [], now = Date.now() } = {}) {
  const tracked = enabledModes.filter(isQuotaTrackedImageMode);
  if (!tracked.length) return null;

  const ledger = await readLedger();
  const cutoff = now - ACTIVITY_WINDOW_MS;
  const limits = [];
  const metrics = [];
  for (const mode of tracked) {
    const entry = ledger?.modes?.[mode] || { renders: [], blockedUntil: null };
    const key = `imagegen-${mode}`;
    const label = rowLabel(mode);
    if (entry.blockedUntil > now) {
      limits.push({
        key,
        label,
        scope: 'image',
        model: MODE_LABELS[mode] || mode,
        percentUsed: 100,
        percentRemaining: 0,
        resetsAt: new Date(entry.blockedUntil).toISOString(),
        timezone: null,
      });
      continue;
    }
    const recent = (entry.renders || []).filter((r) => r.at >= cutoff);
    const failed = recent.filter((r) => !r.ok).length;
    metrics.push({
      key,
      label,
      value: recent.length ? `${recent.length} render${recent.length === 1 ? '' : 's'} · 24h` : 'No renders · 24h',
      detail: failed ? `${failed} failed` : 'quota not reported by this CLI',
    });
  }

  return {
    family: 'imagegen',
    label: 'Image Gen',
    supported: true,
    // Not a burnable quota target: these cards carry no measurable headroom,
    // so the quota-burn candidate feed must never treat a blocked image
    // backend as capacity to spend down.
    burnable: false,
    limits,
    activity: [],
    metrics,
    approximate: true,
    fetchedAt: new Date(now).toISOString(),
    note: 'These image backends expose no quota API, so PortOS reports what it observes: a limit appears only after a render is actually refused. The CLI\'s own usage panel covers the agent model, not the image backend.',
  };
}
