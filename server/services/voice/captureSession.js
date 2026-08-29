/**
 * A live meeting-capture session — the second mode on the call-host page.
 *
 * Reuses the same BlackHole capture path and STT endpointing as the FaceTime
 * call session, but never runs the LLM/tools pipeline: it only accumulates a
 * timestamped transcript while the session is active. On stop it appends the
 * transcript to the daily journal and files it as a Brain inbox item for
 * manual review — the usual summarize/tag flow applies only once the user
 * asks for it. **No AI provider is called by this module**, per the
 * cold-bootstrap policy in AGENTS.md: a captured meeting sits in the inbox
 * exactly like a manually-typed thought with auto-classify off, not like one
 * that gets silently classified in the background.
 *
 * One capture, one host — the same single-attach rule as the call session
 * (`callSession.js`), and mutually exclusive with an active FaceTime call:
 * both want the same BlackHole input device and the same host tab. That
 * exclusion is enforced by the socket layer (`server/sockets/voice.js`),
 * which is the one place that already knows about both sessions.
 */

import { appendJournal, getToday } from '../brainJournal.js';
import { createInboxLog } from '../brainStorage.js';

export const CAPTURE_STATES = ['idle', 'listening', 'ended'];

const initialState = () => ({
  state: 'idle',
  startedAt: null,
  transcript: [], // { text, at }
  endedReason: null,
});

let session = initialState();
let host = null;
let listener = null;

// Injectable so the write path can be driven with stubs instead of the real
// journal/inbox services and a real clock.
let deps = { appendJournal, getToday, createInboxLog, now: Date.now };

/** Test seam — override the write path/clock, or restore the real ones. */
export const __setCaptureSessionDeps = (overrides = {}) => {
  deps = { appendJournal, getToday, createInboxLog, now: Date.now, ...overrides };
};

const publicState = () => ({
  state: session.state,
  active: session.state === 'listening',
  hostAttached: Boolean(host),
  startedAt: session.startedAt,
  endedReason: session.endedReason,
  turns: session.transcript.length,
});

const emitState = () => {
  const snapshot = publicState();
  try {
    listener?.(snapshot);
  } catch (error) {
    console.error(`❌ voice capture: state listener failed: ${error.message}`);
  }
  return snapshot;
};

/** Register the sink for `voice:capture:state` broadcasts. */
export const setCaptureStateListener = (fn) => { listener = fn; };

export const getCaptureState = () => publicState();
export const getCaptureHost = () => host;
export const isCaptureActive = () => publicState().active;

/**
 * Claim the single capture-host slot.
 *
 * Refused rather than displaced, mirroring `callSession.attachHost` — two
 * tabs reading the same BlackHole device would each try to transcribe, and
 * the loser would have no way to know it had been silently muted.
 */
export function attachCaptureHost(socket) {
  if (host && host !== socket && host.connected !== false) return { ok: false, reason: 'host-taken' };
  host = socket;
  console.log(`🎙️ voice capture: host attached (${socket?.id ?? 'socket'})`);
  return { ok: true, state: emitState() };
}

export async function detachCaptureHost(socket) {
  if (host !== socket) return publicState();
  host = null;
  console.log('🎙️ voice capture: host detached');
  // Losing the host loses the audio path, so a running capture is ended
  // rather than left listening with nothing feeding it.
  if (publicState().active) return endCapture('host-detached');
  return emitState();
}

/** Begin accumulating a transcript. Fails closed when nothing holds the slot. */
export function startCapture(socket) {
  if (host !== socket) return { ok: false, reason: 'no-capture-host' };
  if (publicState().active) return { ok: false, reason: 'capture-in-progress' };
  session = { ...initialState(), state: 'listening', startedAt: deps.now() };
  return { ok: true, state: emitState() };
}

/** Record one transcribed utterance, timestamped as it arrived. */
export function recordUtterance(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || !publicState().active) return publicState();
  session.transcript.push({ text: trimmed, at: deps.now() });
  return emitState();
}

/** HH:MM:SS in UTC — deterministic regardless of the host machine's locale/timezone. */
export const formatClockTime = (ms) => new Date(ms).toISOString().slice(11, 19);

const renderTranscript = (transcript) => transcript
  .map((turn) => `[${formatClockTime(turn.at)}] ${turn.text}`)
  .join('\n');

/**
 * End the capture and write the transcript down.
 *
 * Both writes are best-effort: a failed write must not leave the session
 * stuck `listening`, because the state is what gates starting the next
 * capture. The journal and inbox writes are independent — a failure in one
 * must not skip the other.
 */
export async function endCapture(reason = 'ended') {
  if (session.state !== 'listening') return publicState();
  const transcript = session.transcript;
  const startedAt = session.startedAt;
  const endedAt = deps.now();
  session.endedReason = reason;
  session.state = 'ended';
  emitState();

  if (transcript.length) {
    const body = `Meeting capture\n${formatClockTime(startedAt)}–${formatClockTime(endedAt)} UTC\n${renderTranscript(transcript)}`;
    try {
      await deps.appendJournal(await deps.getToday(), body, { source: 'voice' });
    } catch (error) {
      console.error(`❌ voice capture: journal append failed: ${error.message}`);
    }
    try {
      // Same shape as a manually-typed thought with auto-classify off
      // (brain.js captureThought's `mode === 'off'` path): needs_review, no
      // `ai` metadata, because no provider was ever invoked for it.
      await deps.createInboxLog({ capturedText: body, source: 'voice', status: 'needs_review' });
    } catch (error) {
      console.error(`❌ voice capture: inbox capture failed: ${error.message}`);
    }
  }

  session = { ...initialState(), endedReason: reason };
  return emitState();
}

/** Test helper — drop all state between cases. */
export const __resetCaptureSession = () => {
  session = initialState();
  host = null;
  listener = null;
  __setCaptureSessionDeps();
};
