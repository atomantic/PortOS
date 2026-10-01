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
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, IMAGE_TOOL_NAMES, modeLabel } from './imageGen/modes.js';
import { imageGenEvents } from './imageGenEvents.js';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isObservedBlockActive, parseObservedReset } from '../lib/quotaReset.js';

const STATE_FILE = () => join(PATHS.data, 'imagegen-quota.json');

// Renders older than this drop out of the rolling activity window.
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
// Cap the retained render log so a batch run can't grow the file without
// bound. Both bounds do work: a batch can exceed this inside one 24h window.
const MAX_RENDER_SAMPLES = 200;
// How long a block whose refusal stated no reset time stays shown. Bounds an
// otherwise-permanent block on an install that stops rendering (a successful
// render clears it immediately, but nothing forces one to happen).
const UNKNOWN_BLOCK_TTL_MS = 60 * 60 * 1000;

// Only the cloud CLIs spend remote image quota — local renders run on the
// user's own GPU and external hits their own SD endpoint, so neither has
// anything to report. Keyed off CLOUD_IMAGE_GEN_MODES rather than a second
// hand-maintained list, so a 4th cloud backend is tracked the moment it is
// added there. Display names come from `modeLabel` for the same reason — one
// backend must not appear under two names across the UI.
//
// fal.ai is the one cloud backend excluded: it is billed per image on a metered
// account, not drawn from a subscription quota window, so there is no reset to
// observe and its failures (content policy, bad input) are not quota blocks.
// Its spend is recorded per render instead (`estimatedCostUsd` in the sidecar).
export const isQuotaTrackedImageMode = (mode) => CLOUD_IMAGE_GEN_MODES.includes(mode) && mode !== IMAGE_GEN_MODE.FAL;

/** Card id for the image-gen quota card, in the same namespace as the provider
 * family ids in providerUsage.js — a per-family read has to be able to name it. */
export const IMAGE_GEN_FAMILY = 'imagegen';

const rowLabel = (mode) =>
  `${modeLabel(mode)} · ${IMAGE_TOOL_NAMES[mode] || 'image tool'}`;

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
 * Phrases that mean "the image backend refused because you are out of quota".
 *
 * EVERY pattern here must be anchored to quota context, because the text being
 * classified is the model's own narration — which routinely quotes the image
 * prompt back. A bare `\b429\b` matched "I will not draw route 429 signage";
 * a bare "credit" would match "a wizard holding a credit card". A prompt is
 * user content, so any pattern a prompt can satisfy by accident paints a
 * phantom 0%-left meter on an ordinary content decline.
 *
 * These deliberately do NOT delegate to the toolkit's `analyzeError`. That
 * classifier is first-match-wins and its `/billing|payment|credit|insufficient
 * funds/` rule sits ABOVE its rate-limit rule, so "rate limit exceeded; prompt
 * was: a wizard holding a credit card" classifies as QUOTA_EXCEEDED — meaning
 * you cannot filter out the prompt-echo false positive by dropping that
 * category without also dropping the real rate limit underneath it. Matching
 * the phrases directly is order-independent and says what it means.
 */
const IMAGE_QUOTA_PATTERNS = [
  /(?:error|status|code|http)\W{0,12}429\b/i,
  /\b429\b\W{0,40}(?:resource[\s_-]*exhausted|too many requests|rate.?limit|quota)/i,
  /resource[\s_-]*exhausted/i,
  /exhausted your (?:capacity|quota)/i,
  /quota (?:will reset|exceeded|exhausted)/i,
  /out of (?:quota|credits)/i,
  /insufficient[\s_-]*quota/i,
  /rate.?limit(?:ed|s)?\b/i,
  /too many requests/i,
  /hit your (?:usage )?limit/i,
];

/**
 * Classify a failed render's error text. Returns `{ exhausted, resetsAt }`
 * where `resetsAt` is epoch ms or null. Pure given `now`; exported for tests.
 */
export function parseImageQuotaSignal(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return { exhausted: false, resetsAt: null };
  if (!IMAGE_QUOTA_PATTERNS.some((re) => re.test(s))) return { exhausted: false, resetsAt: null };
  // Shared with the quota-burn denial ledger — a refusal's own stated reset is
  // parsed the same way wherever it is observed (see `parseObservedReset`).
  return { exhausted: true, resetsAt: parseObservedReset(s, { now }) };
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
      entry.blockedAt = null;
      entry.blockedUntil = null;
    } else {
      const signal = parseImageQuotaSignal(error, { now: at });
      if (signal.exhausted) {
        // `blockedAt` is what marks the backend blocked; `blockedUntil` only
        // says WHEN it lifts and is legitimately unknown (a refusal need not
        // state a reset). Keying "blocked" off blockedUntil alone collapsed
        // "blocked, reset unknown" into "not blocked".
        entry.blockedAt = at;
        // Never downgrade a known reset to unknown: a repeat attempt during an
        // active block typically returns a bare 429 without restating the reset
        // the first one gave us, which would otherwise erase it.
        entry.blockedUntil = signal.resetsAt ?? entry.blockedUntil ?? null;
      }
    }
    await atomicWrite(STATE_FILE(), ledger);
  });
}

let subscribed = false;

// Single tail over every outcome the bus handlers have dispatched. An emitter
// cannot await its listeners, so the handlers below are fire-and-forget and
// nothing else can answer "has the render just announced on the bus actually
// been written yet?". The recorder's write is real disk I/O — and on Windows
// `atomicWrite` additionally sleeps between rename retries when the
// destination is momentarily locked — so its latency is unbounded and a test
// that sleeps a fixed number of milliseconds instead is a flake by
// construction (#4788). Tests await this tail instead.
let dispatched = Promise.resolve();

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
    // Already caught, so the tail below can never reject or go unhandled.
    const recorded = recordImageGenOutcome({ mode: payload?.mode, ok, error: payload?.error })
      .catch((err) => console.error(`❌ Image-gen quota hook: ${err.message}`));
    dispatched = dispatched.then(() => recorded);
  };
  imageGenEvents.on('completed', note(true));
  imageGenEvents.on('failed', note(false));
  subscribed = true;
}

/** Test-only: allow a suite to re-subscribe against fresh listeners. */
export function __resetImageGenQuotaHookForTests() {
  subscribed = false;
  dispatched = Promise.resolve();
}

/**
 * Test-only: settle every render outcome the bus handlers have dispatched, so
 * a suite can assert on the ledger the instant the recorder is done rather
 * than guessing at a sleep. Loops until quiescent, so work a settling handler
 * chains on is drained too.
 */
export async function __drainImageGenQuotaHookForTests() {
  let seen;
  do {
    seen = dispatched;
    await seen;
  } while (dispatched !== seen);
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
  // A failed/corrupt read is NOT "no renders" — reporting a cheerful zero for a
  // ledger we could not read is the sentinel-vs-empty footgun this card exists
  // to avoid. Say so instead.
  if (!ledger) {
    return {
      family: IMAGE_GEN_FAMILY,
      label: 'Image Gen',
      supported: true,
      burnable: false,
      limits: [],
      activity: [],
      metrics: [],
      approximate: true,
      fetchedAt: new Date(now).toISOString(),
      error: 'Could not read the observed image-quota ledger — render counts and any active limit are unavailable.',
    };
  }
  const cutoff = now - ACTIVITY_WINDOW_MS;
  const limits = [];
  const metrics = [];
  for (const mode of tracked) {
    const entry = ledger.modes?.[mode] || { renders: [], blockedAt: null, blockedUntil: null };
    const key = `imagegen-${mode}`;
    const label = rowLabel(mode);
    // Blocked while the stated reset is still ahead, or — when the refusal
    // never stated one — for a bounded window after we observed it, so an
    // unknown-reset block still shows but can't stick forever on an install
    // that stops rendering. A success clears it either way.
    const blocked = isObservedBlockActive(
      { at: entry.blockedAt, until: entry.blockedUntil },
      { now, ttlMs: UNKNOWN_BLOCK_TTL_MS },
    );
    if (blocked) {
      limits.push({
        key,
        label,
        scope: 'image',
        model: modeLabel(mode),
        percentUsed: 100,
        percentRemaining: 0,
        // Null when the provider didn't state one — the meter renders without a
        // "resets" line rather than showing a time we made up.
        resetsAt: entry.blockedUntil ? new Date(entry.blockedUntil).toISOString() : null,
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
    family: IMAGE_GEN_FAMILY,
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
