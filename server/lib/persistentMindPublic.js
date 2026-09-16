/** Safe client projection for the machine-local persistent-mind state. */

import { nextPersistentMindWakeAt } from './persistentMind.js';
import { normalizePersistentMindThinkingSelection } from './persistentMindThinkingPresets.js';
import { isUsageLimitPauseReason } from './persistentMindUsageLimit.js';

const publicReason = (state) => {
  if (!state.pauseReason) return null;
  // A quota autopause is NOT a user action. Saying "Paused by user" there is the
  // exact confusion this projection exists to prevent: the page would blame the
  // human for a provider limit it will retry out of on its own.
  if (isUsageLimitPauseReason(state.pauseReason)) return 'Provider usage limit reached';
  if (state.status === 'paused') return 'Paused by user';
  if (state.status === 'degraded' || state.status === 'interrupted') return 'Provider unavailable or wake failed';
  return 'Waiting for the next eligible wake';
};

// The route the claimed turn is ACTUALLY running on, which is not always the
// home profile: a temporary thinking session borrows another one for its single
// turn. A field the claim never recorded stays null rather than falling back to
// the profile — "unknown" and "the default" are different answers to "what is
// this turn spending", and only the caller can decide how to say so.
const publicActiveRoute = (activeTurn) => {
  if (!activeTurn) return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  return {
    providerId: text(activeTurn.providerId),
    model: text(activeTurn.model),
    effort: text(activeTurn.effort),
  };
};

// The accepted selection carried by the message the active turn is answering.
// Presentation only — consent already happened at admission, and the resolver
// re-validates the route against the saved preset before any provider call.
const publicActiveThinkingSession = (activeTurn) => {
  const request = activeTurn?.wake?.thinkingRequest;
  const message = request ? { thinkingPresetId: request.selection.id, thinkingPreset: request.selection }
    : activeTurn?.wake?.kind === 'message' ? activeTurn.wake.message : null;
  if (!message?.thinkingPresetId) return null;
  const selection = normalizePersistentMindThinkingSelection(message.thinkingPreset);
  return {
    presetId: message.thinkingPresetId,
    // A message whose stored selection no longer validates is exactly the
    // "revoked mid-flight" case the resolver refuses; say so instead of
    // rendering a route the turn will not be allowed to take.
    label: selection?.label || null,
    providerId: selection?.providerId || null,
    model: selection?.model || null,
    effort: selection?.effort ?? null,
    resolvable: selection !== null,
  };
};

export function publicPersistentMindState(state = {}) {
  const nextWakeAt = nextPersistentMindWakeAt(state);
  const activeTurn = state.activeTurn || null;
  const queuedMessages = Array.isArray(state.queuedMessages) ? state.queuedMessages : [];
  return {
    enabled: state.enabled === true,
    started: state.started === true,
    status: typeof state.status === 'string' ? state.status : 'unknown',
    pauseReason: publicReason(state),
    // The one pause the mind clears by itself. The page needs it separated from
    // an ordinary user pause so it can say "blocked, retrying at X" rather than
    // leaving a quota stall indistinguishable from a deliberate stop.
    usageLimited: isUsageLimitPauseReason(state.pauseReason),
    queuedMessageCount: queuedMessages.length,
    // How many of those queued messages will spend a borrowed (possibly
    // account-backed) route, so the page can say that a pause is holding paid
    // work rather than only ordinary heartbeat messages.
    queuedTemporaryMessageCount: queuedMessages.filter((message) => Boolean(message?.thinkingPresetId)).length,
    activeTurnId: typeof activeTurn?.id === 'string' ? activeTurn.id : null,
    // Turn freshness. Timestamps only — the derived age belongs to whoever has a
    // clock to subtract with, and /mind/runtime already reports it against the
    // server clock for the page that renders live progress.
    activeTurnStartedAt: typeof activeTurn?.startedAt === 'string' ? activeTurn.startedAt : null,
    activeTurnHeartbeatAt: typeof activeTurn?.heartbeatAt === 'string' ? activeTurn.heartbeatAt : null,
    activeRoute: publicActiveRoute(activeTurn),
    activeThinkingSession: publicActiveThinkingSession(activeTurn),
    lastCompletedTurnId: typeof state.lastCompletedTurnId === 'string' ? state.lastCompletedTurnId : null,
    lastCompletedAt: typeof state.lastCompletedAt === 'string' ? state.lastCompletedAt : null,
    nextEligibleWakeAt: typeof state.nextEligibleWakeAt === 'string' ? state.nextEligibleWakeAt : null,
    nextWakeAt: nextWakeAt == null ? null : new Date(nextWakeAt).toISOString(),
    failureCount: Number.isInteger(state.failureCount) ? state.failureCount : 0,
    lastError: state.lastError ? 'The last wake did not complete; local diagnostics have details' : null,
  };
}
