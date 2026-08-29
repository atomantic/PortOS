/**
 * The one active FaceTime Audio call.
 *
 * Phase 1 gave PortOS a control plane that can dial and hang up; the call-host
 * page gives it ears and a mouth. This module owns the state in between: which
 * call is up, whether anyone can hear it, when to give up, and what is written
 * down afterwards.
 *
 * Three deliberate constraints:
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
 */

import { appendJournal, getToday } from '../brainJournal.js';
import * as facetimeBridge from './facetimeBridge.js';
import { getVoiceConfig } from './config.js';

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
});

let session = initialState();
let host = null;
let timer = null;
let listener = null;

// Injectable so the state machine can be driven with stubs and fake timers
// instead of a real helper and a real call.
let deps = { probe: facetimeBridge.probe, call: facetimeBridge.call, hangup: facetimeBridge.hangup, appendJournal, now: Date.now };

/** Test seam — override the helper/clock, or restore the real ones. */
export const __setCallSessionDeps = (overrides = {}) => {
  deps = { probe: facetimeBridge.probe, call: facetimeBridge.call, hangup: facetimeBridge.hangup, appendJournal, now: Date.now, ...overrides };
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
  return snapshot;
};

/** Register the sink for `voice:call:state` broadcasts. */
export const setCallStateListener = (fn) => { listener = fn; };

export const getCallState = () => publicState();
export const getCallHost = () => host;
export const isCallActive = () => publicState().active;

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
  return { ok: true, state: emitState() };
}

export async function detachHost(socket) {
  if (host !== socket) return publicState();
  host = null;
  console.log('📞 voice call: host detached');
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

/**
 * Place a call. Fails closed when nothing can carry the audio.
 */
export async function startCall({ openingLine = '', context = null } = {}) {
  if (!host) return { ok: false, reason: 'no-call-host' };
  if (publicState().active) return { ok: false, reason: 'call-in-progress' };

  session = { ...initialState(), state: 'dialing', startedAt: deps.now(), lastVoiceAt: deps.now() };
  emitState();
  try {
    await deps.call();
  } catch (error) {
    session.endedReason = 'dial-failed';
    setState('idle');
    return { ok: false, reason: 'dial-failed', message: error.message };
  }
  startPolling();
  return { ok: true, state: publicState(), openingLine, context };
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

  session = { ...initialState(), endedReason: reason };
  return emitState();
}

/** Test helper — drop all state between cases. */
export const __resetCallSession = () => {
  stopPolling();
  session = initialState();
  host = null;
  listener = null;
  __setCallSessionDeps();
};
