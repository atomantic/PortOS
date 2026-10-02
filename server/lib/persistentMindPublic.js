/** Safe client projection for the machine-local persistent-mind state. */

import { nextPersistentMindWakeAt } from './persistentMind.js';
import { normalizePersistentMindThinkingSelection } from './persistentMindThinkingPresets.js';
import { isUsageLimitPauseReason } from './persistentMindUsageLimit.js';
import {
  isContextBudgetPauseReason,
  publicContextBudgetReason,
} from './persistentMindContextBudget.js';

// Pauses the human asked for: the default supervisor reason plus the Mind
// page's own label. Anything else (an operator/agent API pause for OOM safety,
// a held policy refusal, ...) is NOT a user pause and must say what it is.
const USER_PAUSE_REASON = /^paused (?:by user|from (?:the )?mind page)\b/i;

// Pause text is operator/system-authored, but a held refusal can echo provider
// output, so scrub anything that looks like a credential before it leaves.
const SECRETISH = /\b(?:sk-[A-Za-z0-9_-]{4,}|bearer\s+\S+|(?:api[_-]?key|token|key|secret|password)\s*[=:]\s*\S+|[A-Za-z0-9+/_-]{32,})/gi;
const scrubReason = (text) => text.replace(SECRETISH, '[redacted]').replace(/\s+/g, ' ').trim();

export const isUserPersistentMindPauseReason = (reason) => typeof reason === 'string' && USER_PAUSE_REASON.test(reason.trim());

const publicReason = (state) => {
  // A quota autopause is NOT a user action. Saying "Paused by user" there is the
  // exact confusion this projection exists to prevent: the page would blame the
  // human for a provider limit it will retry out of on its own.
  if (isUsageLimitPauseReason(state.pauseReason)) return 'Provider usage limit reached';
  // Context-budget / known-window-below-request failures are similarly not a
  // user pause, and the numbers are safe to show so the operator can raise
  // numCtx instead of staring at "Provider unavailable or wake failed".
  const contextBudget = publicContextBudgetReason(state.pauseReason)
    || publicContextBudgetReason(state.lastError);
  if (contextBudget) return contextBudget;
  if (!state.pauseReason) return null;
  if (state.status === 'paused') {
    if (isUserPersistentMindPauseReason(state.pauseReason)) return 'Paused by user';
    return scrubReason(state.pauseReason) || 'Paused by the system';
  }
  if (state.status === 'degraded' || state.status === 'interrupted') return 'Provider unavailable or wake failed';
  return 'Waiting for the next eligible wake';
};

// Coarse, safe classification of why the last wake failed. Free-form provider
// errors never pass through, but "killed (OOM?)" vs "canceled" vs "generic" is
// the difference between an operator knowing what to fix and not.
const WAKE_FAILURE_LABELS = [
  [/\b(?:SIGKILL|OOM|out of memory|killed|exit(?:ed)? (?:code )?137)\b/i, 'The last wake was killed (possibly out of memory); local diagnostics have details'],
  [/heartbeat expired/i, 'The last wake stopped sending heartbeats and was interrupted'],
  [/orphaned .*after restart|daemon stopped/i, 'The last wake was interrupted by a restart'],
  [/\b(?:cancel(?:l?ed)?|abort(?:ed)?|interrupted)\b/i, 'The last wake was canceled before it completed'],
];

const publicLastError = (state) => {
  if (!state.lastError) return null;
  const contextBudget = publicContextBudgetReason(state.lastError)
    || publicContextBudgetReason(state.pauseReason);
  // Safe: only token counts + recovery hint — never prompts or API keys.
  if (contextBudget) return contextBudget;
  // Older state stored the pause text as lastError too; a pause is not a wake
  // failure, so don't render it as one.
  if (state.status === 'paused' && state.lastError === state.pauseReason
    && !isUsageLimitPauseReason(state.pauseReason)) return null;
  const match = WAKE_FAILURE_LABELS.find(([pattern]) => pattern.test(state.lastError));
  return match ? match[1] : 'The last wake did not complete; local diagnostics have details';
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
    // Non-transient local fitness block: the page must not look like a vague
    // provider outage, and must not imply an automatic retry is coming.
    contextBudgetBlocked: isContextBudgetPauseReason(state.pauseReason)
      || isContextBudgetPauseReason(state.lastError),
    queuedMessageCount: queuedMessages.length,
    // How many of those queued messages will spend a borrowed (possibly
    // account-backed) route, so the page can say that a pause is holding paid
    // work rather than only ordinary heartbeat messages.
    queuedTemporaryMessageCount: queuedMessages.filter((message) => Boolean(message?.thinkingPresetId)).length,
    activeTurnId: typeof activeTurn?.id === 'string' ? activeTurn.id : null,
    activeRoute: publicActiveRoute(activeTurn),
    activeThinkingSession: publicActiveThinkingSession(activeTurn),
    lastCompletedTurnId: typeof state.lastCompletedTurnId === 'string' ? state.lastCompletedTurnId : null,
    lastCompletedAt: typeof state.lastCompletedAt === 'string' ? state.lastCompletedAt : null,
    nextEligibleWakeAt: typeof state.nextEligibleWakeAt === 'string' ? state.nextEligibleWakeAt : null,
    nextWakeAt: nextWakeAt == null ? null : new Date(nextWakeAt).toISOString(),
    failureCount: Number.isInteger(state.failureCount) ? state.failureCount : 0,
    // Kept independent of pauseReason: a pause must not hide why the last
    // wake failed, and a failed wake must not be mistaken for the pause cause.
    lastError: publicLastError(state),
  };
}
