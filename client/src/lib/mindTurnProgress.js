/**
 * Live progress derivation for a Persistent Mind turn (#7409).
 *
 * The Mind page used to render one indefinite three-dot indicator for every
 * non-idle state, so "healthy but slow local inference", "the turn wedged and
 * the watchdog has not noticed yet", and "the provider hit a quota and the mind
 * auto-paused" all looked identical. Everything needed to tell them apart is
 * already reported — `GET /mind/runtime` carries turn freshness measured
 * against the SERVER clock, and the public state carries the pause/retry
 * fields — so this module only has to read them.
 *
 * Two rules the callers depend on:
 *   - Turn freshness is taken from the runtime snapshot ONLY when its `turnId`
 *     matches the claimed turn. A snapshot from the previous turn would
 *     otherwise date a fresh turn and read as stalled.
 *   - A missing measurement stays `null` and renders nothing. "Not reported"
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
 * Describe what the mind is doing right now.
 *
 * @param {object} args
 * @param {object|null} args.state — public persistent-mind state
 * @param {object|null} args.runtime — `GET /mind/runtime` snapshot
 * @param {Array|null} args.events — visible trajectory events
 * @returns {{phase: 'thinking'|'stalled'|'blocked'|'idle', busy: boolean,
 *   stage: string|null, elapsedMs: number|null, heartbeatAgeMs: number|null,
 *   residency: string|null, retryAt: string|null, reason: string|null,
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
    || (!thinking && ['degraded', 'interrupted'].includes(state?.status));
  const stalled = thinking && inference?.heartbeatStale === true;

  const residency = thinking
    ? RESIDENCY_LABELS[inference?.residency?.status] || null
    : null;
  const phase = blocked ? 'blocked' : stalled ? 'stalled' : thinking ? 'thinking' : 'idle';

  const parts = [];
  if (phase === 'blocked') {
    if (trimmed(state?.nextEligibleWakeAt)) parts.push('retrying automatically');
  } else if (phase !== 'idle') {
    if (elapsedMs !== null) parts.push(formatDurationMs(elapsedMs));
    if (heartbeatAgeMs !== null) {
      parts.push(stalled ? `no heartbeat for ${formatDurationMs(heartbeatAgeMs)}` : `heartbeat ${formatDurationMs(heartbeatAgeMs)} ago`);
    }
    if (residency) parts.push(residency);
  }

  return {
    phase,
    busy: phase === 'thinking' || phase === 'stalled',
    stage: phase === 'idle' || phase === 'blocked' ? null : mindTurnStage(state, events),
    elapsedMs,
    heartbeatAgeMs,
    residency,
    retryAt: phase === 'blocked' ? trimmed(state?.nextEligibleWakeAt) : null,
    reason: phase === 'blocked' ? trimmed(state?.pauseReason) : null,
    detail: parts.length > 0 ? parts.join(' · ') : null,
  };
}
