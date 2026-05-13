// Server-pushed voice output for the Chief of Staff.
//
// Normal voice turns are user-initiated: the user speaks/types, the LLM
// streams a reply, TTS goes back over the socket. Proactive speech lets the
// CoS speak FIRST — alerts, briefings, reminders — without a user turn.
//
// Three things make this non-trivial:
//   1. Quiet hours. Users don't want the bot piping up at 2am.
//   2. Barge-in. If the user is mid-utterance the proactive line yields.
//   3. Delivery channel. It uses the same Socket.IO `voice:speak` event the
//      client already plays back from the TTS pipeline, so the existing
//      barge-in path (voice:interrupt → stopPlayback) cancels proactive
//      audio for free.
//
// Pure-function quiet-hour / barge-in helpers are exported separately so
// they can be unit-tested without spinning up a server.

import { synthesize } from './tts.js';
import { getVoiceConfig } from './config.js';
import { rememberTtsForAllSockets } from './echo.js';
import { getUserTimezone, getLocalParts } from '../../lib/timezone.js';

// 24-hour HH:MM regex shared with the route-level Zod schema in
// `routes/voice.js`. Both ends of the config write path validate the same
// shape so a passing schema is guaranteed to parse here.
export const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// Parse "HH:MM" → minutes-from-midnight. Returns null for malformed input so
// the caller can decide whether to fall through (quiet hours off) or error.
export const parseHHMM = (s) => {
  if (typeof s !== 'string') return null;
  const m = s.match(HHMM_RE);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

// Maximum spoken-text length for proactive lines. The /api/voice/speak Zod
// schema already caps HTTP payloads at 4000 chars, but `speakProactive` is
// also called directly by internal subsystems (CoS, scheduler, etc.) that
// bypass the route validator. Enforce the same bound here so a runaway
// caller can't trigger multi-minute synthesis and a multi-megabyte socket
// payload. Exposed so the route can import the same constant if it ever
// needs to.
export const MAX_PROACTIVE_TEXT_LEN = 4000;

// Quiet-hours window inclusion check. Handles the overnight case (start>end,
// e.g. 22:00 → 07:00) by wrapping. Same-value start/end means "the window is
// empty" — proactive speech is always allowed.
export const isWithinQuietHours = ({ start, end, nowMinutes }) => {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null) return false;
  if (s === e) return false;
  if (s < e) return nowMinutes >= s && nowMinutes < e;
  // Overnight wrap: in-window if at-or-after start OR before end.
  return nowMinutes >= s || nowMinutes < e;
};

// Pull the user's current local minutes-from-midnight via Intl. Server runs
// TZ=UTC, so a naive `new Date().getHours()` would compare quiet hours
// against UTC and silently let the bot speak during the user's bedtime.
const getLocalMinutes = async () => {
  const tz = await getUserTimezone();
  const parts = getLocalParts(new Date(), tz);
  return parts.hour * 60 + parts.minute;
};

// Pure decision helper — given a config snapshot + current local minutes,
// should this proactive speech go out? Tested directly without time mocking.
export const shouldSpeak = (cfg, nowMinutes) => {
  if (!cfg?.enabled) return { ok: false, reason: 'voice-disabled' };
  const proactive = cfg.llm?.proactive;
  if (!proactive?.enabled) return { ok: false, reason: 'proactive-disabled' };
  if (proactive.quietHours?.enabled) {
    if (isWithinQuietHours({
      start: proactive.quietHours.start,
      end: proactive.quietHours.end,
      nowMinutes,
    })) {
      return { ok: false, reason: 'quiet-hours' };
    }
  }
  return { ok: true };
};

// Speak a line to every connected client. `io` is the Socket.IO server
// passed from socket.js (no global stash so tests can inject a fake).
//
// `priority` is informational for now — clients can decide whether to
// surface a toast for high-priority lines or just speak. Reserved field;
// keep the API surface ready for it.
//
// Returns { ok, reason?, latencyMs? } so callers know whether the line
// went out or was suppressed.
export const speakProactive = async ({ io, text, priority = 'normal', source = 'cos' }) => {
  if (!io) return { ok: false, reason: 'no-io' };
  const trimmed = (text || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PROACTIVE_TEXT_LEN) {
    console.warn(`🔕 voice: proactive too-long (${trimmed.length} > ${MAX_PROACTIVE_TEXT_LEN}) "${trimmed.slice(0, 60)}…"`);
    return { ok: false, reason: 'too-long', chars: trimmed.length, maxChars: MAX_PROACTIVE_TEXT_LEN };
  }

  const cfg = await getVoiceConfig();
  // Only resolve the user's local time when the decision actually depends on
  // it. getLocalMinutes() reads settings via getUserTimezone() and is the
  // only async work in the suppression path; skipping it when quiet hours
  // are disabled keeps proactive sends cheap (one fewer fs read + Intl call
  // per line) and removes an avoidable async failure surface.
  const nowMinutes = cfg?.llm?.proactive?.quietHours?.enabled
    ? await getLocalMinutes()
    : 0;
  const decision = shouldSpeak(cfg, nowMinutes);
  if (!decision.ok) {
    console.log(`🔕 voice: proactive suppressed (${decision.reason}) "${trimmed.slice(0, 60)}"`);
    return decision;
  }

  const { wav, latencyMs } = await synthesize(trimmed);
  // Mirror the per-turn `state.recentTts` write so a proactive line bleeding
  // from speakers back into the mic gets dropped as echo on the next turn.
  rememberTtsForAllSockets(trimmed);
  // `voice:speak` is the proactive-speech channel — distinct from per-turn
  // `voice:tts:audio` so the client can render a different visual cue
  // (subtle pill instead of full conversation entry) and skip recording
  // it as part of the dialogue history.
  io.emit('voice:speak', {
    sentence: trimmed,
    wav,
    latencyMs,
    priority,
    source,
    ts: Date.now(),
  });
  console.log(`🔔 voice: proactive sent (${priority}) "${trimmed.slice(0, 80)}" (${latencyMs}ms synth)`);
  return { ok: true, latencyMs };
};
