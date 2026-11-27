// Server-pushed voice output for the Chief of Staff.
//
// Proactive speech lets the CoS speak FIRST (alerts, briefings, reminders) without
// a user turn. It honors quiet hours and barge-in (a mid-utterance user wins), and
// uses the same `voice:speak` Socket.IO event the client already plays from the TTS
// pipeline, so voice:interrupt → stopPlayback cancels it for free.
//
// Pure quiet-hour / barge-in helpers are exported separately for unit tests.

import { synthesize } from './tts.js';
import { getVoiceConfig } from './config.js';
import { rememberTtsForAllSockets } from './echo.js';
import { emitVoiceOutput } from './voiceOutput.js';
import { getLocalParts, isWithinTimeWindow } from '../../lib/timezone.js';
import { getUserTimezone } from '../userTimezone.js';
import { VOICE_TEXT_MAX_CHARS } from '../../lib/apiContractSchemas.js';

// HH:MM helpers live in server/lib/timezone.js (shared with the dashboard's
// time-window validator); re-exported for the route-level Zod schema and tests.
export { HHMM_RE } from '../../lib/timezone.js';

// Max spoken-text length for proactive lines. The route's Zod schema caps HTTP at
// 4000, but internal callers (CoS, scheduler) bypass it; enforce the same bound so a
// runaway caller can't trigger multi-minute synthesis.
export const MAX_PROACTIVE_TEXT_LEN = VOICE_TEXT_MAX_CHARS;

// Quiet hours are the generic half-open [start, end) time-window predicate with
// overnight wrap (same start/end = empty window), under a domain name.
export const isWithinQuietHours = isWithinTimeWindow;

// Pull the user's current local minutes-from-midnight via Intl. Server runs
// TZ=UTC, so a naive `new Date().getHours()` would compare quiet hours
// against UTC and silently let the bot speak during the user's bedtime.
export const getLocalMinutes = async () => {
  const tz = await getUserTimezone();
  const parts = getLocalParts(new Date(), tz);
  return parts.hour * 60 + parts.minute;
};

// Pure decision helper — given a config snapshot + current local minutes,
// should this proactive speech go out? Tested directly without time mocking.
//
// `solicited` marks a line the user explicitly asked for (e.g. the completion
// of a coding task they dispatched by voice). Such lines skip the
// proactive-enabled gate — the user opted in by issuing the request — but
// still honor voice-disabled and quiet hours (no piping up at 3am, PR or not).
export const shouldSpeak = (cfg, nowMinutes, { solicited = false } = {}) => {
  if (!cfg?.enabled) return { ok: false, reason: 'voice-disabled' };
  const proactive = cfg.llm?.proactive;
  if (!solicited && !proactive?.enabled) return { ok: false, reason: 'proactive-disabled' };
  if (proactive?.quietHours?.enabled) {
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

// Speak a line through the designated voice-output tab or an authorized
// pre-upgrade client. `io` is passed by the caller so tests can inject a fake.
// `priority` is reserved/informational. Returns { ok, reason?, latencyMs? }.
export const speakProactive = async ({ io, text, priority = 'normal', source = 'cos', solicited = false }) => {
  if (!io) return { ok: false, reason: 'no-io' };
  const trimmed = (text || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PROACTIVE_TEXT_LEN) {
    console.log(`🔕 voice: proactive too-long (${trimmed.length} > ${MAX_PROACTIVE_TEXT_LEN} chars)`);
    return { ok: false, reason: 'too-long', chars: trimmed.length, maxChars: MAX_PROACTIVE_TEXT_LEN };
  }

  const cfg = await getVoiceConfig();
  // Only resolve local time when the decision depends on it (an async settings
  // read); skipped when quiet hours are disabled.
  const nowMinutes = cfg?.llm?.proactive?.quietHours?.enabled
    ? await getLocalMinutes()
    : 0;
  const decision = shouldSpeak(cfg, nowMinutes, { solicited });
  if (!decision.ok) {
    // Voice off, or proactive speech off, is the install's steady configuration.
    // Logging it on every task dequeue drowns the server log in lines that
    // describe a choice already made. Quiet hours and oversized text are events.
    if (decision.reason !== 'voice-disabled' && decision.reason !== 'proactive-disabled') {
      console.log(`🔕 voice: proactive suppressed (${decision.reason}, chars=${trimmed.length})`);
    }
    return decision;
  }

  const { wav, latencyMs } = await synthesize(trimmed);
  // `voice:speak` is distinct from per-turn `voice:tts:audio` so the client can
  // render a subtle pill and skip dialogue history.
  const delivery = await emitVoiceOutput(io, 'voice:speak', {
    sentence: trimmed,
    wav,
    latencyMs,
    priority,
    source,
    ts: Date.now(),
  });
  if (!delivery.delivered) return { ok: false, reason: 'no-recipient' };
  // Mirror the per-turn `state.recentTts` write so a proactive line bleeding from
  // speakers into the mic is dropped as echo. Remembered on EVERY socket, not just
  // the recipient: a sibling tab on the same machine hears it through the shared
  // mic and must suppress it too, or the bot answers its own voice. The cost is a
  // rare false drop of a close 4+ word phrase within the 8s window.
  rememberTtsForAllSockets(trimmed);
  console.log(`🔔 voice: proactive sent (${priority}, chars=${trimmed.length}, ${latencyMs}ms synth)`);
  return { ok: true, latencyMs };
};
