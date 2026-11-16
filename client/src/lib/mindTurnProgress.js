/**
 * Live progress derivation for a Persistent Mind turn (#7409).
 *
 * The Mind page used to render one indefinite three-dot indicator for every
 * non-idle state, so "healthy but slow local inference", "the turn wedged and
 * the watchdog has not noticed yet", and "the provider hit a quota and the mind
 * auto-paused" all looked identical. Everything needed to tell them apart is
 * already reported — `GET /mind/runtime` carries turn freshness measured
 * against the SERVER clock plus the usage-limit probe schedule, and the public
 * state carries the pause fields — so this module only has to read them.
 *
 * Two rules the callers depend on:
 *   - Turn freshness is taken from the runtime snapshot ONLY when its `turnId`
 *     matches the claimed turn. A snapshot from the previous turn would
 *     otherwise date a fresh turn and read as stalled.
 *   - A missing measurement renders nothing rather than zero. "Not reported"
 *     and "zero elapsed" are different answers; collapsing them would show a
 *     just-started turn as having no heartbeat.
 *
 * Privacy: every string here is derived from status enums and durations. No
 * provider reasoning, prompt text, or trajectory payload crosses into it — the
 * hidden chain-of-thought boundary stays exactly where `persistentMindVisibility`
 * put it.
 */

import { formatDurationMs } from '../utils/formatters.js';

/** Turn stages the trajectory can pin, newest event wins. */
const STAGE_LABELS = {
  'mind.wake': 'Preparing context',
  'mind.model.request': 'Waiting on the model',
  'mind.model.result': 'Reading the model response',
  'mind.capability.request': 'Running a granted action',
  'mind.capability.result': 'Reading the action result',
  'mind.thought': 'Continuing after a working note',
  'mind.memory.candidate': 'Proposing a memory',
  'mind.memory.created': 'Saving a memory',
};

// Only the statuses that answer "is the local runtime actually processing?".
// `provider-managed` and `unconfigured` map to nothing on purpose: there is no
// local residency to report, and inventing a clause would imply otherwise.
const RESIDENCY_LABELS = {
  loaded: 'model loaded',
  'not-loaded': 'loading model',
  unknown: 'local runtime unreachable',
};

const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The runtime snapshot for THIS turn, or null when it describes another one.
 * A turn with no id (state still loading) never matches.
 */
export function mindTurnRuntimeSnapshot(state, runtime) {
  const turnId = trimmed(state?.activeTurnId);
  const inference = runtime?.inference;
  if (!turnId || !inference?.active || trimmed(inference.turnId) !== turnId) return null;
  return inference;
}

/** Newest trajectory stage for the claimed turn, or null when none is pinned. */
export function mindTurnStage(state, events) {
  const turnId = trimmed(state?.activeTurnId);
  if (!turnId || !Array.isArray(events)) return null;
  let best = null;
  for (const event of events) {
    if (event?.turnId !== turnId || !STAGE_LABELS[event.kind]) continue;
    // `sequence` is the trajectory's own monotonic order; a bare array position
    // would be wrong after a merge that backfilled an older page.
    if (best === null || (event.sequence ?? -1) >= (best.sequence ?? -1)) best = event;
  }
  return best ? STAGE_LABELS[best.kind] : null;
}

/**
 * The one phrasing of a blocked/stalled turn, so the header pill and the chat
 * indicator cannot drift apart on wording.
 *
 * @param {object} progress — a `describeMindTurnProgress` result
 * @param {(iso: string) => string} formatRetry — renders `retryAt` as a relative span
 */
export function mindTurnHeadline(progress, formatRetry) {
  if (progress.phase === 'stalled') return 'Stalled, checking…';
  if (progress.phase !== 'blocked') return null;
  const reason = progress.reason || 'Blocked';
  return progress.retryAt ? `${reason} · retry ${formatRetry(progress.retryAt)}` : reason;
}

/**
 * Describe what the mind is doing right now.
 *
 * @param {object} args
 * @param {object|null} args.state — public persistent-mind state
 * @param {object|null} args.runtime — `GET /mind/runtime` snapshot
 * @param {Array|null} args.events — visible trajectory events
 * @returns {{phase: 'thinking'|'stalled'|'blocked'|'idle', busy: boolean,
 *   stage: string|null, retryAt: string|null, reason: string|null,
 *   detail: string|null}}
 */
export function describeMindTurnProgress({ state, runtime, events } = {}) {
  const inference = mindTurnRuntimeSnapshot(state, runtime);
  const elapsedMs = Number.isFinite(inference?.elapsedMs) ? inference.elapsedMs : null;
  const heartbeatAgeMs = Number.isFinite(inference?.heartbeatAgeMs) ? inference.heartbeatAgeMs : null;
  const thinking = state?.status === 'thinking' && Boolean(trimmed(state?.activeTurnId));
  // A degraded/interrupted wake is as opaque as a quota pause: both stop making
  // progress and both retry on their own, so both get the retry time inline.
  const blocked = state?.usageLimited === true
    || state?.contextBudgetBlocked === true
    || ['degraded', 'interrupted'].includes(state?.status);
  const stalled = thinking && inference?.heartbeatStale === true;
  const phase = blocked ? 'blocked' : stalled ? 'stalled' : thinking ? 'thinking' : 'idle';
  const busy = phase === 'thinking' || phase === 'stalled';

  const parts = [];
  if (busy) {
    if (elapsedMs !== null) parts.push(formatDurationMs(elapsedMs));
    if (heartbeatAgeMs !== null) {
      parts.push(stalled
        ? `no heartbeat for ${formatDurationMs(heartbeatAgeMs)}`
        : `heartbeat ${formatDurationMs(heartbeatAgeMs)} ago`);
    }
    const residency = RESIDENCY_LABELS[inference?.residency?.status];
    if (residency) parts.push(residency);
  }

  return {
    phase,
    busy,
    stage: busy ? mindTurnStage(state, events) : null,
    // Each block reads its OWN retry axis. A usage-limit autopause clears
    // `nextEligibleWakeAt` (no backoff gate, no failureCount climb), so its
    // schedule lives only in the readiness probe; a degraded wake sets the
    // backoff gate and has no probe. Reading the probe for both would let a
    // leftover quota schedule stand in for a degraded wake's real retry.
    retryAt: phase !== 'blocked' ? null
      : state?.usageLimited === true
        ? trimmed(runtime?.usageLimitRetryAt)
        // Context-budget autopauses clear nextEligibleWakeAt and do not probe;
        // never invent a retry time that would imply the mind will recover alone.
        : state?.contextBudgetBlocked === true
          ? null
          : trimmed(state?.nextEligibleWakeAt),
    reason: phase === 'blocked' ? trimmed(state?.pauseReason) : null,
    detail: parts.length > 0 ? parts.join(' · ') : null,
  };
}
