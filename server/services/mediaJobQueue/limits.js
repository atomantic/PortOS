/**
 * Media job lanes and their limits: which lane and swim lane a job occupies,
 * each provider's parallel limit, and the rate-limit (429) and quota cooldowns
 * that narrow or hold a swim lane. Owns that state; the queue reads it through
 * these functions. Quota cooldowns ride in the queue snapshot
 * (snapshotQuotaCooldowns / restoreQuotaCooldowns).
 */

import { getSettings } from '../settings.js';
import { parseQuotaDeferral, formatDeferral } from '../../lib/imageQuotaSignal.js';
import { CLOUD_IMAGE_GEN_MODES, CLOUD_VIDEO_GEN_MODES, mediaJobExecutionLane, mediaJobSwimlane } from '../../lib/generationModes.js';
import { isRemoteMediaJob } from './remoteMediaJob.js';

// Cloud-CLI jobs (Codex/Grok/Agy images, Grok videos) run in the parallel cloud
// lane — each render shells out to its own external child spending remote
// quota, so they don't serialize on the MLX runtime the way GPU jobs do. Each
// provider is its own swim lane (see jobSwimlane) with `codexParallelLimit`
// slots (settings key `imageGen.codex.parallelLimit`, kept under the codex name
// for backward compat), so a Codex backlog never holds a Grok render.
export const isCloudImageJob = (j) =>
  mediaJobExecutionLane({ kind: j.kind, mode: j.params?.mode }) === 'cloud';

export const isLocalFinishReplay = (job) => job.kind === 'image' && job.params?.visualProfile && job.params?.visualProfileSource
  && !job.params?.remoteMedia?.reconcile && job.params?.remotePeerReservation !== true;

const laneInput = (job) => ({
  kind: job.kind,
  mode: job.params?.mode || job.mode,
  remote: isRemoteMediaJob(job),
  peerId: job.params?.remoteMedia?.peerId,
});
export const jobLane = (job) => isLocalFinishReplay(job) ? 'gpu' : mediaJobExecutionLane(laneInput(job));
// The unit that owns slots and queue positions: one per cloud provider, one per
// federated peer, one for this machine's accelerator. Work waits only behind
// work in its own swim lane.
export const jobSwimlane = (job) => isLocalFinishReplay(job) ? 'gpu:local' : mediaJobSwimlane(laneInput(job));

// One install can route to several peers, while each provider remains the
// authority on its own capacity. This bound prevents corrupted persisted state
// from creating unbounded local polling loops without serializing independent
// peers behind the local GPU lane.
export const REMOTE_MEDIA_PARALLEL_LIMIT = 20;

export const CODEX_PARALLEL_MIN = 1;
// Keep counts exactly representable without imposing a provider throughput cap.
export const CODEX_PARALLEL_MAX = Number.MAX_SAFE_INTEGER;
export const CODEX_PARALLEL_DEFAULT = 1;

export const PARALLEL_LIMIT_MIN = 1;
export const PARALLEL_LIMIT_MAX = Number.MAX_SAFE_INTEGER;
export const PARALLEL_LIMIT_DEFAULT = 1;
export const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

let codexParallelLimit = CODEX_PARALLEL_DEFAULT;
const parallelLimits = new Map();
const rateLimitCooldowns = new Map();

const clampParallel = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 1) return CODEX_PARALLEL_DEFAULT;
  return Math.min(Math.floor(x), CODEX_PARALLEL_MAX);
};
export const clampParallelLimit = clampParallel;

export const getCodexParallelLimit = () => codexParallelLimit;
export function setCodexParallelLimit(n) {
  codexParallelLimit = clampParallel(n);
  parallelLimits.set('image:codex', codexParallelLimit);
  return codexParallelLimit;
}

function _getParallelLimit(target, maybeMode) {
  const kind = typeof target === 'string' ? target : target?.kind;
  const mode = typeof target === 'string' ? maybeMode : (target?.params?.mode || target?.mode);
  if (kind && mode) {
    const specific = parallelLimits.get(`${kind}:${mode}`);
    if (specific !== undefined) return specific;
  }
  if (kind === 'image' && mode === 'codex') {
    return codexParallelLimit;
  }
  return PARALLEL_LIMIT_DEFAULT;
}

function _setParallelLimit(target, modeOrN, maybeN) {
  let kind, mode, n;
  if (typeof target === 'string') {
    kind = target;
    mode = modeOrN;
    n = maybeN;
  } else {
    kind = target?.kind;
    mode = target?.mode;
    n = modeOrN;
  }
  const clamped = clampParallel(n);
  if (kind && mode) {
    parallelLimits.set(`${kind}:${mode}`, clamped);
  }
  if (kind === 'image' && mode === 'codex') {
    codexParallelLimit = clamped;
  }
  return clamped;
}

const getParallelLimit = _getParallelLimit;
const setParallelLimit = _setParallelLimit;

export function syncParallelLimits(s) {
  if (!s) return;
  for (const mode of CLOUD_IMAGE_GEN_MODES) {
    const parallelLimit = s.imageGen?.[mode]?.parallelLimit;
    if (parallelLimit !== undefined) setParallelLimit('image', mode, parallelLimit);
  }
  for (const mode of CLOUD_VIDEO_GEN_MODES) {
    const parallelLimit = s.videoGen?.[mode]?.parallelLimit;
    if (parallelLimit !== undefined) setParallelLimit('video', mode, parallelLimit);
  }
}

export async function refreshCodexParallelLimit() {
  const s = await getSettings();
  syncParallelLimits(s);
  return setCodexParallelLimit(s?.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
}

function _getEffectiveParallelLimit(target, maybeMode, now = Date.now()) {
  const job = typeof target === 'string' ? { kind: target, params: { mode: maybeMode } } : target;
  const configured = getParallelLimit(job);
  const cooldown = getRateLimitCooldown(job, now);
  if (cooldown && cooldown.expiresAt > now) {
    return Math.min(configured, cooldown.effectiveLimit);
  }
  return configured;
}

function _getRateLimitCooldown(target, maybeModeOrNow, maybeNow) {
  let job, now;
  if (typeof target === 'string') {
    job = { kind: target, params: { mode: maybeModeOrNow } };
    now = typeof maybeNow === 'number' ? maybeNow : Date.now();
  } else {
    job = target;
    now = typeof maybeModeOrNow === 'number' ? maybeModeOrNow : Date.now();
  }
  const key = jobSwimlane(job);
  const cooldown = rateLimitCooldowns.get(key);
  if (cooldown && cooldown.expiresAt > now) {
    return {
      ...cooldown,
      active: true,
      penalty: Math.max(0, getParallelLimit(job) - cooldown.effectiveLimit),
    };
  }
  if (cooldown) rateLimitCooldowns.delete(key);
  return null;
}

function _recordRateLimitCooldown(target, errorTextOrMode, payloadOrReset, now = Date.now()) {
  let job, errorText, payload;
  if (typeof target === 'string') {
    job = { kind: target, params: { mode: errorTextOrMode } };
    errorText = typeof payloadOrReset === 'string' ? payloadOrReset : 'HTTP 429 Too Many Requests';
    payload = typeof payloadOrReset === 'object' ? payloadOrReset : (typeof payloadOrReset === 'number' ? { resetsInMs: payloadOrReset, status: 429 } : { status: 429 });
  } else {
    job = target;
    errorText = errorTextOrMode;
    payload = payloadOrReset || {};
  }
  const errStr = String(errorText || payload?.error || payload?.message || '');
  const status = payload?.status || payload?.statusCode || payload?.upstreamStatus;
  const is429 = status === 429 || /\b429\b|rate.?limit|too many requests/i.test(errStr);
  if (!is429) return false;

  const key = jobSwimlane(job);
  const configured = getParallelLimit(job);
  const existing = rateLimitCooldowns.get(key);
  const currentLimit = (existing && existing.expiresAt > now) ? existing.effectiveLimit : configured;
  // At one slot there is no smaller positive concurrency: hold the lane until
  // the provider's cooldown expires instead of burning each waiting job.
  const effectiveLimit = Math.max(0, currentLimit - 1);
  const deferral = parseQuotaDeferral(errStr);
  const duration = payload?.resetsInMs || deferral?.resetsInMs || RATE_LIMIT_COOLDOWN_MS;
  const expiresAt = now + duration;

  rateLimitCooldowns.set(key, {
    effectiveLimit,
    expiresAt,
    cause: errStr.slice(0, 200),
  });
  console.log(`⚠️ media-job: ${key} received 429 / rate-limit — lowering effective limit to ${effectiveLimit} for cool-down (${Math.round(duration / 1000)}s)`);
  return true;
}

const getRateLimitCooldown = _getRateLimitCooldown;

export {
  _getParallelLimit as getParallelLimit,
  _setParallelLimit as setParallelLimit,
  _getEffectiveParallelLimit as getEffectiveParallelLimit,
  _getRateLimitCooldown as getRateLimitCooldown,
  _recordRateLimitCooldown as recordRateLimitCooldown,
};

export function rateLimitWaitMessage(effectiveLimit, expiresAt) {
  const at = new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Rate-limited (429) — cooling down (limit: ${effectiveLimit}) until ${at}`;
}

// One definition of each lane's per-swim-lane slot count, shared by the
// dispatcher, getQueueCapacity and laneConcurrencyFor so a caller can never read
// a limit this module has moved. Cloud providers each get `codexParallelLimit`;
// a federated peer runs one job at a time, and REMOTE_MEDIA_PARALLEL_LIMIT
// bounds all peers together.
export const laneLimits = () => ({
  gpu: 1,
  cloud: codexParallelLimit,
  remote: 1,
});
export const laneTotalLimits = () => ({ gpu: 1, cloud: Infinity, remote: REMOTE_MEDIA_PARALLEL_LIMIT });

// Per-backend quota cooldowns: mode → epoch ms the provider said it resets.
//
// A subscription image backend answers an exhausted quota with the instant it
// recovers ("Your quota will reset after 2h26m1s"). Without this, every job
// queued behind the one that hit the wall dispatches straight into the same
// 429 and fails within seconds — on 2026-10-17 a single comic run burned ten
// renders that way, each one a failed slot the user had to notice and re-drive
// by hand.
//
// Keyed by MODE, not by job: the quota belongs to the provider account, so one
// job's rejection is evidence about every queued job routed to that backend.
// Queue-level rather than per-job because `captureQueueSnapshot` serializes a
// fixed field whitelist, so a new per-job field would silently not survive a
// restart; this rides alongside `videoHolds` in the same snapshot instead.
const quotaCooldowns = new Map();

/** Remaining cooldown for a job's backend, 0 when it is clear to dispatch. */
/** The reset instant for a job's backend, or 0 when it is clear to dispatch. */
export function quotaCooldownResumeAt(job, now = Date.now()) {
  const mode = job?.params?.mode;
  if (!mode) return 0;
  const resumeAt = quotaCooldowns.get(mode);
  if (!resumeAt) return 0;
  if (resumeAt <= now) {
    // Expired — drop it so a later failure starts a fresh window rather than
    // extending a stale one, and so the map cannot grow without bound.
    quotaCooldowns.delete(mode);
    return 0;
  }
  return resumeAt;
}

/**
 * Record a cooldown when a failure carries the provider's own reset time.
 * Called from the failed handler for its EVIDENCE only — the job still fails
 * through the normal terminal path, so no lifecycle invariant changes here.
 */
export function recordQuotaCooldown(job, errorText) {
  const mode = job?.params?.mode;
  if (!mode) return;
  const deferral = parseQuotaDeferral(errorText);
  if (!deferral) return;
  const existing = quotaCooldowns.get(mode) || 0;
  // Keep the later instant: a second rejection during the same outage reports a
  // shorter remaining wait, and taking it would release the queue early.
  if (deferral.resumeAt <= existing) return;
  quotaCooldowns.set(mode, deferral.resumeAt);
  console.log(`⏳ media-job: ${mode} quota exhausted — holding queued ${mode} renders for ${formatDeferral(deferral.resetsInMs)}`);
}

// Derived from the ABSOLUTE reset so the message is constant for the whole
// window: a countdown would change every tick and force a full-queue snapshot
// per held job each time it did.
export const QUOTA_WAIT_PATTERN = /^Waiting for \S+ quota — resumes at /;
export function quotaWaitMessage(mode, resumeAt) {
  const at = new Date(resumeAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `Waiting for ${mode} quota — resumes at ${at}`;
}

/** Snapshot shape: [[mode, resumeAt], ...], dropping anything already expired. */
export function snapshotQuotaCooldowns(now = Date.now()) {
  return [...quotaCooldowns.entries()].filter(([, resumeAt]) => resumeAt > now);
}

/**
 * Restore cooldowns across a restart. Returns false on a malformed snapshot so
 * the caller can latch persistence the same way a malformed hold does — but
 * never throws: an unreadable cooldown must not keep the server from booting.
 */
export function restoreQuotaCooldowns(raw, now = Date.now()) {
  quotaCooldowns.clear();
  if (raw === undefined || raw === null) return true;
  if (!Array.isArray(raw)) return false;
  let ok = true;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) { ok = false; continue; }
    const [mode, resumeAt] = entry;
    if (typeof mode !== 'string' || !mode || !Number.isFinite(resumeAt)) { ok = false; continue; }
    if (resumeAt > now) quotaCooldowns.set(mode, resumeAt);
  }
  return ok;
}

// Test-only: a test that set a limit or tripped a cooldown must not leak it
// into the next one.
export function resetLimitsForTests() {
  quotaCooldowns.clear();
  codexParallelLimit = CODEX_PARALLEL_DEFAULT;
  parallelLimits.clear();
  rateLimitCooldowns.clear();
}
