/**
 * The one active FaceTime Audio call.
 *
 * Phase 1 gave PortOS a control plane that can dial and hang up; the call-host
 * page gives it ears and a mouth. This module owns the state in between: which
 * call is up, whether anyone can hear it, when to give up, and what is written
 * down afterwards.
 *
 * Four deliberate constraints:
 *
 * - **One call, one host.** A second call-host tab is refused rather than
 *   allowed to double-answer, mirroring the single-attach shell-session
 *   pattern. Without an attached host there is no call, because a call nobody
 *   can hear is worse than no call at all.
 * - **The helper is the source of truth.** State follows what `probe()` reports
 *   about the real FaceTime window, not what PortOS believes it asked for — a
 *   call the user picked up or declined on their phone has to be observed.
 * - **Only text is kept.** The transcript goes to the daily journal like any
 *   other voice turn. The audio is never persisted, and the configured handle
 *   never appears in what is written down.
 * - **Answering is fail-closed, and reading is not answering.** The incoming
 *   watcher (`pollIncoming`) is only ever armed while a call-host tab is
 *   attached (`attachHost`/`detachHost`), so it never runs unobserved. Within
 *   a tick, `probe()` is a safe read — it never presses anything, and the
 *   native helper reports nothing distinguishing "no call" from "a caller who
 *   is not the configured identity" (fail-closed at the helper boundary), so
 *   this module never learns an unauthorized caller exists and never logs
 *   one. Only `answer()` — the press — is additionally gated on the host
 *   being attached *at press time*, because answering a call nobody can hear
 *   is worse than missing it.
 */

import { appendJournal, getToday } from '../brainJournal.js';
import * as facetimeBridge from './facetimeBridge.js';
import { getVoiceConfig } from './config.js';
import { getLocalMinutes, isWithinQuietHours } from './proactiveSpeech.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';
import { EventEmitter } from 'events';

export const CALL_STATES = ['idle', 'dialing', 'connected', 'listening', 'speaking', 'ended'];
export const PROBE_INTERVAL_MS = 2_000;
// A caller who has said nothing for this long has walked away or hung up
// somewhere PortOS cannot see.
export const SILENCE_HANGUP_MS = 60_000;
const DEFAULT_MAX_CALL_MINUTES = 15;

const initialState = () => ({
  state: 'idle',
  startedAt: null,
  lastVoiceAt: null,
  endedReason: null,
  transcript: [],
  // 'user' — PortOS placed this call on request. 'mind' — the Persistent Mind
  // placed it (voice.call-user). 'inbound' — the user called PortOS and the
  // autoAnswer watcher answered it. `origin` decides whether the transcript
  // is handed back to the persistent mind afterwards; `openingLine` is what
  // the call host speaks the moment the far end picks up (consumed once, so a
  // state re-emit cannot make it say it twice).
  origin: 'user',
  openingLine: '',
  context: null,
  // Only meaningful for `origin === 'inbound'`: whether the Persistent Mind
  // was running at the moment the call was answered. Captured once so a mind
  // that starts or stops mid-call cannot flip the hangup handoff decision.
  mindEnabled: false,
});

let session = initialState();
let host = null;
let timer = null;
let listener = null;

// Broadcast sink for anything other than the call-host socket — the Mind tab
// wants to show an active-call chip regardless of which tab is carrying the
// audio. `listener` above stays a single slot owned by the attached host
// (it also drives that socket's opening-line delivery); this is a plain
// multi-subscriber event, mirroring `notificationEvents` in notifications.js.
export const callStateEvents = new EventEmitter();

// Injectable so the state machine can be driven with stubs and fake timers
// instead of a real helper and a real call.
// Imported lazily: the persistent-mind supervisor pulls in a large service
// graph, and a call the mind did not place — or answer — never needs it.
const enqueueMindMessage = async (text) => {
  const { enqueuePersistentMindMessage } = await import('../persistentMindSupervisor.js');
  return enqueuePersistentMindMessage({ text });
};

const isMindEnabled = async () => {
  const { getPersistentMindState } = await import('../persistentMindSupervisor.js');
  const state = await getPersistentMindState();
  return Boolean(state?.enabled);
};

const buildInboundContext = async () => {
  const { buildInboundCallContext } = await import('../persistentMindCallCapability.js');
  return buildInboundCallContext();
};

const MISSED_CALL_TITLES = {
  'no-host': 'Missed call from you — the call host was not attached',
  'helper-failed': 'Missed call from you — the FaceTime helper failed to answer',
};

const notifyMissedCall = async (reason) => addNotification({
  type: NOTIFICATION_TYPES.AGENT_WARNING,
  title: MISSED_CALL_TITLES[reason] || 'Missed call from you',
  description: 'An incoming call from your configured identity rang and PortOS could not answer it automatically.',
  priority: PRIORITY_LEVELS.MEDIUM,
  metadata: { source: 'voice-facetime-incoming', reason },
});

const defaultDeps = () => ({
  probe: facetimeBridge.probe,
  call: facetimeBridge.call,
  answer: facetimeBridge.answer,
  hangup: facetimeBridge.hangup,
  appendJournal,
  enqueueMindMessage,
  isMindEnabled,
  buildInboundContext,
  notifyMissedCall,
  now: Date.now,
});

let deps = defaultDeps();

/** Test seam — override the helper/clock, or restore the real ones. */
export const __setCallSessionDeps = (overrides = {}) => {
  deps = { ...defaultDeps(), ...overrides };
};

const publicState = () => ({
  state: session.state,
  active: session.state !== 'idle' && session.state !== 'ended',
  hostAttached: Boolean(host),
  startedAt: session.startedAt,
  endedReason: session.endedReason,
  turns: session.transcript.length,
});

const emitState = () => {
  const snapshot = publicState();
  // The host page and the Mind tab both render call state, so it is broadcast
  // rather than replied to whoever last acted.
  try {
    listener?.(snapshot);
  } catch (error) {
    console.error(`❌ voice call: state listener failed: ${error.message}`);
  }
  callStateEvents.emit('state', snapshot);
  return snapshot;
};

/** Register the sink for `voice:call:state` broadcasts. */
export const setCallStateListener = (fn) => { listener = fn; };

export const getCallState = () => publicState();
export const getCallHost = () => host;
export const isCallActive = () => publicState().active;

/**
 * The bounded briefing the caller-side turns run with, or null for a call the
 * user placed themselves. Read per turn so the pipeline stays stateless.
 */
export const getCallContext = () => (publicState().active ? session.context : null);

/**
 * Take the pending opening line, clearing it. Consume-once on purpose: the
 * host speaks it on the first `connected` observation, and `voice:call:state`
 * is broadcast more than once per call.
 */
export function takeCallOpeningLine() {
  if (!publicState().active) return '';
  const line = session.openingLine;
  session.openingLine = '';
  return line;
}

/**
 * Claim the single call-host slot.
 *
 * Returns `{ ok: false, reason: 'host-taken' }` rather than displacing the
 * incumbent: two tabs reading the same BlackHole device would each answer, and
 * the loser would have no way to know it had been silently muted.
 */
export function attachHost(socket) {
  if (host && host !== socket && host.connected !== false) return { ok: false, reason: 'host-taken' };
  host = socket;
  console.log(`📞 voice call: host attached (${socket?.id ?? 'socket'})`);
  // Arm the incoming-call watcher now that something could carry the audio.
  // Idempotent on a reconnect of the same socket.
  startIncomingWatcher();
  return { ok: true, state: emitState() };
}

export async function detachHost(socket) {
  if (host !== socket) return publicState();
  host = null;
  console.log('📞 voice call: host detached');
  // Never poll for an incoming call with nothing attached to carry it.
  stopIncomingWatcher();
  // Losing the host loses the audio path, so an in-flight call is ended rather
  // than left running deaf.
  if (publicState().active) return endCall('host-detached');
  return emitState();
}

const stopPolling = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

const setState = (next) => {
  if (session.state === next) return publicState();
  session.state = next;
  return emitState();
};

const maxCallMs = async () => {
  const config = await getVoiceConfig();
  const minutes = Number(config?.facetime?.maxCallMinutes);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_CALL_MINUTES) * 60_000;
};

/**
 * One poll tick: reconcile with the helper, then apply the give-up rules.
 *
 * Exported so a test can step the machine deterministically rather than
 * racing a real interval.
 */
export async function pollCall() {
  if (!publicState().active) return publicState();

  let observed = null;
  try {
    observed = await deps.probe();
  } catch (error) {
    // A helper that cannot answer is not evidence the call ended, so the poll
    // is skipped rather than treated as a hangup.
    console.error(`❌ voice call: probe failed: ${error.message}`);
    return publicState();
  }

  if (observed?.state === 'ended' || observed?.state === 'idle') return endCall('remote-hangup');
  if (observed?.state === 'connected' && session.state === 'dialing') setState('listening');

  const now = deps.now();
  if (now - (session.lastVoiceAt ?? session.startedAt) >= SILENCE_HANGUP_MS) return endCall('caller-silent');
  if (now - session.startedAt >= await maxCallMs()) return endCall('max-duration');
  return publicState();
}

const startPolling = () => {
  stopPolling();
  timer = setInterval(() => {
    // Runs outside the request lifecycle: an unhandled rejection here would
    // take the process down rather than reach error middleware.
    pollCall().catch((error) => console.error(`❌ voice call: poll failed: ${error.message}`));
  }, PROBE_INTERVAL_MS);
  timer.unref?.();
};

// ---------------------------------------------------------------------------
// Incoming watcher — armed only while a call-host tab is attached (see
// attachHost/detachHost above). Separate timer from the active-call poll
// above: this one runs while the session is *idle*, watching for a call
// PortOS did not place.
// ---------------------------------------------------------------------------

let incomingTimer = null;
// Edge-detected so a ring that keeps being reported "authorized" for several
// ticks in a row (waiting on a slow answer, or unanswerable because the host
// went away) produces exactly one notification/answer attempt per ring, not
// one every 2 seconds for as long as it rings.
let incomingRingActive = false;

const stopIncomingWatcher = () => {
  if (incomingTimer) clearInterval(incomingTimer);
  incomingTimer = null;
  incomingRingActive = false;
};

const startIncomingWatcher = () => {
  stopIncomingWatcher();
  incomingTimer = setInterval(() => {
    pollIncoming().catch((error) => console.error(`❌ voice call: incoming poll failed: ${error.message}`));
  }, PROBE_INTERVAL_MS);
  incomingTimer.unref?.();
};

const recordMissedCall = async (reason) => {
  try {
    await deps.notifyMissedCall(reason);
  } catch (error) {
    console.error(`❌ voice call: missed-call notification failed: ${error.message}`);
  }
};

/**
 * Compute the greeting an answered call opens with. Quiet hours change the
 * style only, per the decided approach — they never decide whether to
 * answer; the user placed the call, so PortOS answers at any hour.
 */
async function buildInboundGreeting(config) {
  const persona = config?.llm?.personality?.name?.trim() || 'PortOS';
  const quietHours = config?.llm?.proactive?.quietHours;
  let quiet = false;
  if (quietHours?.enabled) {
    const nowMinutes = await getLocalMinutes();
    quiet = isWithinQuietHours({ start: quietHours.start, end: quietHours.end, nowMinutes });
  }
  return quiet
    ? `Hi, this is ${persona}. It's late, so I'll keep this brief — go ahead.`
    : `Hi, this is ${persona}. Go ahead.`;
}

/**
 * Take over the session for a call the helper just answered on our behalf.
 * Skips `dialing` entirely — the helper already reports the call live — and
 * reuses the same `listening` transition the outbound flow drives the
 * opening-line delivery from (see `deliverOpeningLine` in sockets/voice.js).
 */
async function beginAnsweredCall(config) {
  const greeting = await buildInboundGreeting(config);

  let mindEnabled = false;
  try {
    mindEnabled = await deps.isMindEnabled();
  } catch (error) {
    console.error(`❌ voice call: mind status check failed: ${error.message}`);
  }

  let context = null;
  if (mindEnabled) {
    context = await deps.buildInboundContext().catch((error) => {
      // A briefing that failed to assemble is not a reason to leave the call
      // unanswered — the plain persona still carries the conversation.
      console.error(`❌ voice call: inbound context assembly failed: ${error.message}`);
      return null;
    });
  }

  session = {
    ...initialState(),
    state: 'connected',
    startedAt: deps.now(),
    lastVoiceAt: deps.now(),
    origin: 'inbound',
    openingLine: greeting,
    context,
    mindEnabled,
  };
  emitState();
  setState('listening');
  startPolling();
}

/**
 * One incoming-watch tick. Exported so a test can drive it directly, exactly
 * like `pollCall` — including with `host` unset, which the production timer
 * itself never does (see attachHost/detachHost), but which is exactly the
 * "no host attached" failure mode `pollIncoming` still has to handle
 * defensively (a host that detaches in the gap between this tick starting
 * and the answer attempt landing is a real, if narrow, race).
 */
export async function pollIncoming() {
  const config = await getVoiceConfig();
  if (!config?.facetime?.autoAnswer) {
    incomingRingActive = false;
    return { checked: false, reason: 'auto-answer-off' };
  }
  if (publicState().active) return { checked: false, reason: 'call-in-progress' };

  let observed = null;
  try {
    observed = await deps.probe();
  } catch (error) {
    // Mirrors pollCall: a probe that cannot answer is unknown, not evidence
    // of anything — and never carries caller identity, so this is safe to log.
    console.error(`❌ voice call: incoming probe failed: ${error.message}`);
    return { checked: false, reason: 'probe-failed' };
  }

  // The helper reports nothing distinguishing "no call" from "a caller who is
  // not the configured identity" — fail-closed at the helper boundary. Reused
  // here: `authorized` on an idle-session probe means "the ringing caller
  // matches the configured identity", never "no call at all".
  const ringing = Boolean(observed?.authorized) && observed?.state === 'dialing';
  if (!ringing) {
    incomingRingActive = false;
    return { checked: true, incoming: false };
  }
  if (incomingRingActive) return { checked: true, incoming: true, deduped: true };
  incomingRingActive = true;

  if (!host) {
    await recordMissedCall('no-host');
    return { checked: true, incoming: true, answered: false, reason: 'no-host' };
  }

  let result = null;
  try {
    result = await deps.answer();
  } catch (error) {
    console.error(`❌ voice call: incoming answer failed: ${error.message}`);
    await recordMissedCall('helper-failed');
    return { checked: true, incoming: true, answered: false, reason: 'helper-failed' };
  }
  if (!result?.ok) {
    await recordMissedCall('helper-failed');
    return { checked: true, incoming: true, answered: false, reason: 'helper-failed' };
  }

  // Reset the edge detector now: once answered, `publicState().active` short-
  // circuits every tick for the rest of the call (see the top of this
  // function), so the "ring stopped" branch above never runs again to clear
  // it — leaving it stuck `true` would make the *next* genuine incoming call,
  // after this one ends, look like a duplicate of this one and be silently
  // skipped forever.
  incomingRingActive = false;
  await beginAnsweredCall(config);
  return { checked: true, incoming: true, answered: true };
}

/**
 * Place a call. Fails closed when nothing can carry the audio.
 */
export async function startCall({ openingLine = '', context = null, origin = 'user' } = {}) {
  if (!host) return { ok: false, reason: 'no-call-host' };
  if (publicState().active) return { ok: false, reason: 'call-in-progress' };

  session = {
    ...initialState(),
    state: 'dialing',
    startedAt: deps.now(),
    lastVoiceAt: deps.now(),
    origin: origin === 'mind' ? 'mind' : 'user',
    openingLine: typeof openingLine === 'string' ? openingLine.trim() : '',
    context: typeof context === 'string' && context.trim() ? context : null,
  };
  emitState();
  try {
    await deps.call();
  } catch (error) {
    session.endedReason = 'dial-failed';
    setState('idle');
    return { ok: false, reason: 'dial-failed', message: error.message };
  }
  startPolling();
  return { ok: true, state: publicState(), openingLine: session.openingLine, context: session.context };
}

/** Record one side of the conversation. Speaker labels only — never the handle. */
export function recordTurn(speaker, text) {
  const trimmed = (text || '').trim();
  if (!trimmed || !publicState().active) return publicState();
  session.transcript.push({ speaker: speaker === 'assistant' ? 'assistant' : 'caller', text: trimmed });
  if (speaker !== 'assistant') session.lastVoiceAt = deps.now();
  return publicState();
}

/** The caller started talking — used for barge-in and the silence timer. */
export function noteCallerSpeech() {
  if (!publicState().active) return publicState();
  session.lastVoiceAt = deps.now();
  return publicState();
}

export const markSpeaking = () => (publicState().active ? setState('speaking') : publicState());
export const markListening = () => (publicState().active ? setState('listening') : publicState());

const renderTranscript = (transcript) => transcript
  .map((turn) => `${turn.speaker === 'assistant' ? 'PortOS' : 'Caller'}: ${turn.text}`)
  .join('\n');

// Cap on the transcript handed back to the persistent mind. A call is short by
// construction (maxCallMinutes), but the mind's message queue is durable state,
// so the bound is enforced here rather than trusted.
const MIND_TRANSCRIPT_MAX_CHARS = 6_000;

/**
 * End the call and write the transcript down.
 *
 * The journal append is best-effort: a failed write must not leave the session
 * stuck `connected`, because the state is what gates placing the next call.
 */
export async function endCall(reason = 'ended') {
  if (session.state === 'idle') return publicState();
  stopPolling();
  const transcript = session.transcript;
  const origin = session.origin;
  const mindEnabled = session.mindEnabled;
  session.endedReason = reason;
  setState('ended');

  try {
    await deps.hangup();
  } catch (error) {
    console.error(`❌ voice call: hangup failed: ${error.message}`);
  }

  if (transcript.length) {
    try {
      // getToday() is async (it reads the configured timezone) — unawaited it
      // resolved to a pending Promise, which appendJournal's isIsoDate() guard
      // always rejects, so the call transcript was silently never written.
      await deps.appendJournal(await getToday(), `FaceTime Audio call\n${renderTranscript(transcript)}`, { source: 'voice' });
    } catch (error) {
      console.error(`❌ voice call: journal append failed: ${error.message}`);
    }
  }

  // A call the mind placed is one half of a conversation it started, so the
  // outcome goes back into its queue as a message. Without this the next wake
  // would have no idea the call happened and could call again to say the same
  // thing — including after a call nobody picked up, which is exactly when an
  // empty transcript would otherwise leave it uninformed. Best-effort for the
  // same reason the journal append is.
  //
  // An answered inbound call gets the same handoff, but only when the mind
  // was actually running when it was answered — an inbound call answered
  // with the mind off ran the plain voice persona, and telling a mind that
  // never took part about a conversation it did not have would be noise, not
  // continuity.
  const handToMind = origin === 'mind' || (origin === 'inbound' && mindEnabled);
  if (handToMind) {
    const verb = origin === 'mind' ? 'placed' : 'answered';
    try {
      await deps.enqueueMindMessage(
        `Outcome of the FaceTime Audio call you ${verb} (ended: ${reason}):\n${
          transcript.length ? renderTranscript(transcript) : 'The call ended with nothing said.'
        }`.slice(0, MIND_TRANSCRIPT_MAX_CHARS),
      );
    } catch (error) {
      console.error(`❌ voice call: mind transcript handoff failed: ${error.message}`);
    }
  }

  session = { ...initialState(), endedReason: reason };
  return emitState();
}

/** Test helper — drop all state between cases. */
export const __resetCallSession = () => {
  stopPolling();
  stopIncomingWatcher();
  session = initialState();
  host = null;
  listener = null;
  callStateEvents.removeAllListeners();
  __setCallSessionDeps();
};
