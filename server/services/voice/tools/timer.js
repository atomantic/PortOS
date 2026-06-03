// Timer / reminder voice tool: set a one-shot timer that raises a notification
// when it fires. Backed by the persistent scheduler so a timer survives a
// restart and dedups an LLM re-issuing the same one inside a reasoning loop.

import { scheduleTimer } from '../timers.js';

// Timers / reminders — "set a timer", "remind me in N minutes", "ping me in".
export const TIMER_INTENT_RE = /\b(set a timer|start a timer|timer for|remind me (?:in|to)|ping me in|alarm|countdown|wake me)\b/i;

export const TIMER_TOOLS = [
  {
    name: 'timer_set',
    description:
      'Set a one-shot timer or reminder. Use when the user says "set a timer for 10 minutes", "remind me in 30 minutes to call mom", "ping me in an hour". When the timer fires, PortOS raises a notification with the label. Specify the duration in minutes (or seconds for short timers).',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Timer duration in minutes. Use this for most timers.' },
        seconds: { type: 'number', description: 'Timer duration in seconds. Use for short timers; added to minutes if both given.' },
        label: { type: 'string', description: 'What to remind the user about (e.g. "tea is ready", "call mom").' },
      },
    },
    execute: async ({ minutes, seconds, label } = {}) => {
      const mins = Number.isFinite(Number(minutes)) ? Number(minutes) : 0;
      const secs = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
      const totalMs = Math.round((mins * 60 + secs) * 1000);
      // Bound: at least 1s, at most 24h. An LLM-supplied NaN/negative or an
      // absurd duration shouldn't schedule a runaway timer.
      if (!Number.isFinite(totalMs) || totalMs < 1000) {
        return { ok: false, summary: 'Tell me how long — e.g. "set a timer for 10 minutes".' };
      }
      if (totalMs > 24 * 60 * 60 * 1000) {
        return { ok: false, summary: 'Timers are capped at 24 hours. For longer reminders, add a calendar event.' };
      }
      const trimmedLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : 'Timer';
      // Delegate to the persistent scheduler — it survives a restart (re-armed
      // at boot, overdue ones fired once) and dedups an LLM re-issuing the same
      // timer inside one reasoning loop.
      const scheduled = scheduleTimer({ totalMs, label: trimmedLabel });
      const totalSecs = Math.round(totalMs / 1000);
      const human = totalSecs >= 60
        ? `${Math.round(totalSecs / 60)} minute${Math.round(totalSecs / 60) === 1 ? '' : 's'}`
        : `${totalSecs} second${totalSecs === 1 ? '' : 's'}`;
      console.log(`⏰ Timer set for ${human}: "${trimmedLabel}"${scheduled?.deduped ? ' (deduped — already armed)' : ''}`);
      return {
        ok: true,
        durationMs: totalMs,
        label: trimmedLabel,
        summary: `Timer set for ${human}${trimmedLabel !== 'Timer' ? ` — I'll remind you to ${trimmedLabel}` : ''}.`,
      };
    },
  },
];
