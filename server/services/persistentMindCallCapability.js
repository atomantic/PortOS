/**
 * The persistent mind's one outward-reaching authority: ringing the user's
 * phone over FaceTime Audio.
 *
 * Everything else the mind can do lands inside PortOS, where the user finds it
 * when they next look. A call does not wait to be found — it interrupts a
 * person who may be asleep, driving, or in a meeting — so this module is
 * written as a gate first and a feature second. It re-checks the grant AFTER
 * inference (the model does not get to assert its own authority), refuses
 * whenever a browser tab could carry the same words instead, honours the same
 * quiet hours proactive speech does, and enforces a small fixed budget out of
 * durable state so a restart cannot hand back a fresh allowance.
 *
 * Every decision is written to the mind trajectory, including the ones that
 * placed no call, so "why didn't it call me?" and "why did it?" are both
 * answerable from the ledger. The dialed handle never appears there: it is the
 * user's phone number or email, and lives only in voice configuration.
 *
 * The critical-notification escalation in `voice/proactiveTriggers.js` shares
 * this gate with `requireMindGrant: false` — it is authorized by its own
 * `facetime.escalateCritical` setting rather than by the mind's grant, but it
 * is subject to every other check, and above all to the same budget.
 */

import {
  PERSISTENT_MIND_CALL_LIMITS,
  normalizePersistentMindCapabilities,
  persistentMindCallRequestSchema,
} from '../lib/persistentMindCapabilities.js';
import {
  persistentMindCallRateVerdict,
  recordPersistentMindCall,
} from '../lib/persistentMind.js';
import { PERSISTENT_MIND_ID } from '../lib/persistentMindTrajectory.js';
import { sha256Text } from '../lib/fileUtils.js';
import { loadState, saveState, withStateLock } from './cosState.js';
import { appendMindEvent } from './agentRunEventLog.js';
import { normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { preparePersistentMindContext, readPersistentMindMemories } from './persistentMindContext.js';
import { isInstanceFeatureEnabled } from './instanceFeatures.js';
import { getVoiceConfig } from './voice/config.js';
import { getLocalMinutes, isWithinQuietHours } from './voice/proactiveSpeech.js';
import { getVoiceOutputSocket } from './voice/voiceOutput.js';
import { isCallActive, startCall } from './voice/callSession.js';

/**
 * Why a requested call was not placed. Recorded verbatim on the trajectory
 * event, so keep these stable — the Mind tab and the docs name them.
 */
export const PERSISTENT_MIND_CALL_SUPPRESSION_REASONS = Object.freeze([
  'invalid-request',
  'not-granted',
  'feature-disabled',
  'voice-disabled',
  'identity-unconfigured',
  'tab-available',
  'quiet-hours',
  'call-in-progress',
  'too-soon',
  'rate-capped',
  'no-call-host',
  'dial-failed',
  'interrupted',
]);

// The caller-side turns run with a briefing, not the mind's whole life. A call
// is spoken through a small local voice model with a short context window, and
// every turn re-sends this, so the budget is far below the mind's own.
const CALL_CONTEXT_MAX_CHARS = 2_500;

const suppressed = (reason, extra = {}) => ({ placed: false, reason, ...extra });

const trimmedIdentity = (config) => ({
  handle: String(config?.facetime?.targetHandle ?? '').trim(),
  name: String(config?.facetime?.targetName ?? '').trim(),
});

/**
 * Render the bounded briefing a call runs with, so the voice on the phone is
 * continuous with the mind rather than a stranger who happens to share a
 * voice. `intro` sets the scene (outbound vs inbound) — everything else is
 * shared between the two directions.
 *
 * Deliberately built without a summarizer: this runs on the mind's own turn,
 * and a call must never trigger an extra provider round the user did not ask
 * for. An unsummarized older history simply reads as unavailable.
 */
async function buildCallContext(intro) {
  const root = await loadState();
  const prompt = normalizePersistentMindPrompt(root.config?.persistentMindPrompt);
  const memories = await readPersistentMindMemories(PERSISTENT_MIND_ID);
  const context = await preparePersistentMindContext({
    mindId: PERSISTENT_MIND_ID,
    identity: prompt.identity,
    instructions: prompt.instructions,
    memories,
    maxChars: CALL_CONTEXT_MAX_CHARS,
  });
  return [intro, context.text].join('\n\n').slice(0, CALL_CONTEXT_MAX_CHARS * 2);
}

/**
 * The inbound counterpart of the briefing above — used when the user calls
 * PortOS back and the incoming-call watcher (`callSession.js#pollIncoming`)
 * answers with the Persistent Mind running. No `reason` exists for a call the
 * mind did not decide to place, so the intro just orients it to the situation.
 */
export async function buildInboundCallContext() {
  return buildCallContext('You are on a phone call the user placed to reach you directly (they called you, not the other way around). Keep it short, greet them, and let them talk.');
}

/**
 * Persist one placed call into the durable ledger the caps are read from.
 *
 * Uses the same state lock the mind supervisor writes under, so a call landing
 * next to a turn completion cannot lose either write.
 */
async function persistPlacedCall({ at, reason, source }) {
  return withStateLock(async () => {
    const root = await loadState();
    root.persistentMind = recordPersistentMindCall(root.persistentMind, { at, reason, source });
    await saveState(root);
    return root.persistentMind;
  });
}

const callEventId = (turnId, source, reason, at) => (
  `mind-call:${sha256Text(`${turnId || source}:${reason}:${at}`).slice(0, 32)}`
);

const recordCallEvent = async ({ kind, turnId, eventId, data }) => appendMindEvent({
  kind,
  mindId: PERSISTENT_MIND_ID,
  turnId: turnId || null,
  eventId,
  data,
});

/**
 * Describe the call action to the model — only when it is actually granted.
 *
 * An ungranted mind is told the field exists and must stay null, rather than
 * being left to discover the rejection by trying: a model that believes it
 * called the user will say so in its reply, and the user would be waiting for
 * a phone that never rings.
 */
export function buildPersistentMindCallCapabilityPrompt({ enabled } = {}) {
  if (!enabled) {
    return `# Calling the user
Placing a phone call is OFF. Set callRequest to null. You may say that you would call if it mattered, but must never claim a call was placed.`;
  }
  return `# Calling the user
Placing a phone call is ON. Set callRequest when something genuinely cannot wait for the user to look at a screen. The call reaches only the single handle configured in PortOS; you never choose a recipient.

The request is refused, and no call is placed, when any of these hold: a browser tab is open and able to speak to the user, the current local time is inside voice quiet hours, a call is already up, fewer than ${PERSISTENT_MIND_CALL_LIMITS.minGapMs / 60_000} minutes have passed since the last call, or ${PERSISTENT_MIND_CALL_LIMITS.maxPerRollingDay} calls have already been placed in the last 24 hours.

'reason' is for the record and the user, not for the phone. 'openingLine' is spoken aloud the moment they answer, so write one or two plain spoken sentences: say who is calling and why, with no markdown and no lists. Describe the call in your message as requested, never as completed — the outcome is decided after you respond.`;
}

/**
 * Decide on, and if allowed place, one outbound call to the user.
 *
 * @param {object}  input
 * @param {string}  input.reason        Why the call is being placed (recorded).
 * @param {string}  input.openingLine   Spoken the moment the call connects.
 * @param {string}  [input.source]      Which subsystem asked ('mind', …).
 * @param {boolean} [input.requireMindGrant] False for a path authorized by its
 *                                      own setting (notification escalation).
 * @param {string}  [input.turnId]      Mind turn to attribute the events to.
 * @param {AbortSignal} [input.signal]  Aborted turn places no call.
 * @param {number}  [input.now]         Injectable clock for the rate caps.
 * @returns {Promise<{placed: boolean, reason: string|null}>}
 */
export async function requestUserCall({
  reason,
  openingLine,
  source = 'mind',
  requireMindGrant = true,
  turnId = null,
  signal = null,
  now = Date.now(),
} = {}) {
  const parsed = persistentMindCallRequestSchema.safeParse({ reason, openingLine });
  const at = new Date(now).toISOString();
  const eventId = callEventId(turnId, source, parsed.success ? parsed.data.reason : 'invalid', at);

  if (!parsed.success) {
    await recordCallEvent({
      kind: 'mind.call.suppressed',
      turnId,
      eventId: `${eventId}:suppressed`,
      data: { displayText: 'A call request was rejected before any dialing', status: 'invalid-request', source },
    });
    return suppressed('invalid-request');
  }
  const request = parsed.data;

  await recordCallEvent({
    kind: 'mind.call.requested',
    turnId,
    eventId: `${eventId}:requested`,
    data: { displayText: `Requested a call: ${request.reason}`, source },
  });

  const finish = async (outcome) => {
    await recordCallEvent({
      kind: outcome.placed ? 'mind.call.placed' : 'mind.call.suppressed',
      turnId,
      eventId: `${eventId}:${outcome.placed ? 'placed' : 'suppressed'}`,
      data: {
        displayText: outcome.placed
          ? `Called the user: ${request.reason}`
          : `No call placed (${outcome.reason}): ${request.reason}`,
        status: outcome.reason || 'placed',
        source,
      },
    });
    if (!outcome.placed) console.log(`📞 mind call suppressed (${outcome.reason}) source=${source}`);
    return outcome;
  };

  if (signal?.aborted) return finish(suppressed('interrupted'));

  const root = await loadState();
  const capabilities = normalizePersistentMindCapabilities(root.config?.persistentMindCapabilities);
  if (requireMindGrant && !capabilities.callUser) return finish(suppressed('not-granted'));

  if (!await isInstanceFeatureEnabled('facetime')) return finish(suppressed('feature-disabled'));

  const config = await getVoiceConfig();
  if (!config?.enabled) return finish(suppressed('voice-disabled'));
  const identity = trimmedIdentity(config);
  if (!identity.handle || !identity.name) return finish(suppressed('identity-unconfigured'));

  // Checked before quiet hours on purpose: if a tab can speak, the message is
  // already deliverable and no phone needs to ring at any hour.
  if (getVoiceOutputSocket()) return finish(suppressed('tab-available'));

  const quietHours = config?.llm?.proactive?.quietHours;
  if (quietHours?.enabled) {
    const nowMinutes = await getLocalMinutes();
    if (isWithinQuietHours({ start: quietHours.start, end: quietHours.end, nowMinutes })) {
      return finish(suppressed('quiet-hours'));
    }
  }

  if (isCallActive()) return finish(suppressed('call-in-progress'));

  const verdict = persistentMindCallRateVerdict(root.persistentMind, now, PERSISTENT_MIND_CALL_LIMITS);
  if (!verdict.ok) return finish(suppressed(verdict.reason, { retryAt: verdict.retryAt }));

  const context = await buildCallContext(
    `You are speaking on a phone call that you placed to the user. Keep it short, say why you called, and let them talk.\n\n# Why you called\n${request.reason}`,
  ).catch((error) => {
    // A briefing that could not be assembled is not a reason to leave the user
    // uncalled; the opening line alone still carries the message.
    console.error(`❌ mind call: context assembly failed: ${error.message}`);
    return null;
  });

  const result = await startCall({ openingLine: request.openingLine, context, origin: 'mind' });
  if (!result?.ok) return finish(suppressed(result?.reason || 'dial-failed'));

  // Recorded only on a call that actually went out, so a refused dial does not
  // spend the day's budget.
  await persistPlacedCall({ at, reason: request.reason, source });
  console.log(`📞 mind call placed (${source}): ${request.reason.slice(0, 80)}`);
  return finish({ placed: true, reason: null });
}

/** Adapter entry point — run one model-returned `callRequest`. */
export async function executePersistentMindCallRequest({ callRequest, turnId, signal, now } = {}) {
  if (!callRequest) return null;
  return requestUserCall({
    reason: callRequest.reason,
    openingLine: callRequest.openingLine,
    source: 'mind',
    requireMindGrant: true,
    turnId,
    signal,
    ...(Number.isFinite(now) ? { now } : {}),
  });
}
