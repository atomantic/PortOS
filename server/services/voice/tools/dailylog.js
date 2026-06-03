// Daily Log voice tools: open/dictate/append/read the user's journal. Most of
// these push a `navigate` (and sometimes `dictation`) side effect so the client
// follows along. `daily_log_append` is intentionally always-on (the orchestrator
// leaves it out of TOOL_GROUPS) so one-shot "note in today's log: X" works on
// any turn; the other four gate on DAILYLOG_INTENT_RE.

import * as journal from '../../brainJournal.js';

export const DAILY_LOG_PATH = '/brain/daily-log';

// `daily ?logi?n?s?` absorbs whisper/Web-Speech transcription drift on
// "daily log": variants like "daily logs" (plural), "daily login" (heard as
// a familiar word), "daily logins" all gate the daily-log toolset on. The
// \b anchors keep it from matching inside unrelated words like "logging".
export const DAILYLOG_INTENT_RE = /\b(daily ?logi?n?s?|journal|dictat|log entry|log something|to my log|read (?:back )?my log)\b/i;

export const DAILYLOG_TOOLS = [
  {
    name: 'daily_log_open',
    description:
      'Open the Daily Log page AND (typically) start dictation. ONLY use when the user explicitly mentions "daily log", "log entry", "journal", or dictation — NEVER use this as a generic "take me to a page" tool; for any other destination call ui_navigate instead. ' +
      'Use when the user says "open my daily log", "take me to my daily log", "go to daily log", "let\'s make a daily log", "let\'s make a new daily log", "I want to make a log entry", "start my daily log", "new daily log", "let me add to my log". ' +
      'Set startDictation=true (DEFAULT for create-intent phrasings) when the user wants to write content right now — i.e., they said any of: "make"/"start"/"new"/"create"/"dictate"/"record"/"talk into"/"log something". ' +
      'Set startDictation=false ONLY when the user explicitly just wants to LOOK at the page without writing — i.e., they said "show me", "open"/"go to" without any create/write verb. ' +
      'When in doubt, prefer startDictation=true — voice users almost always want to write, and they can say "stop dictation" to exit. ' +
      'After calling, confirm briefly in one short sentence and stay quiet so the dictation system can capture freely.',
    parameters: {
      type: 'object',
      properties: {
        startDictation: {
          type: 'boolean',
          description: 'Immediately enter dictation mode — subsequent speech is appended to the log verbatim instead of sent to you as conversation. DEFAULT TRUE for create/write intent ("make"/"start"/"new"/"dictate"); only false when the user explicitly just wants to view the page.',
        },
      },
    },
    execute: async ({ startDictation = false } = {}, ctx = {}) => {
      const date = await journal.getToday();
      const entry = await journal.getJournal(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      if (startDictation) {
        ctx.sideEffects?.push({ type: 'dictation', enabled: true, date });
      }
      const existingLen = entry?.content?.length || 0;
      const parts = [`Opened daily log for ${date}`];
      if (startDictation) parts.push('Dictation mode on — everything you say now will be added to today\'s log. Say "stop dictation" when done.');
      else if (existingLen) parts.push(`(${entry.segments?.length || 1} segment${entry.segments?.length === 1 ? '' : 's'} so far).`);
      else parts.push('(empty so far).');
      return { ok: true, date, dictation: !!startDictation, summary: parts.join(' ') };
    },
  },

  {
    name: 'daily_log_start_dictation',
    description:
      'Begin voice dictation into the Daily Log: subsequent user speech is transcribed and appended verbatim to today\'s log until they say stop. Use when the user says "start dictation", "record my log", "begin logging", "dictate this", "I want to start talking into my daily log". After calling, do not comment further — just confirm briefly.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Target date YYYY-MM-DD; defaults to today.' },
      },
    },
    execute: async ({ date } = {}, ctx = {}) => {
      const target = await journal.resolveDate(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      ctx.sideEffects?.push({ type: 'dictation', enabled: true, date: target });
      return { ok: true, date: target, summary: `Dictation on for ${target}. Everything you say will be added to the log. Say "stop dictation" when finished.` };
    },
  },

  {
    name: 'daily_log_stop_dictation',
    description:
      'End voice dictation and return to normal conversation mode. Only useful if dictation is currently active. Use when the user says "stop dictation", "end dictation", "I\'m done", "exit dictation mode".',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      ctx.sideEffects?.push({ type: 'dictation', enabled: false });
      return { ok: true, summary: 'Dictation off.' };
    },
  },

  {
    name: 'daily_log_append',
    description:
      'Append a text segment to a Daily Log entry (does NOT enter dictation mode — one-shot). Use when the user says "add to my daily log: X", "write in my daily log that X", "note in today\'s log: X". Exact text goes in; do not summarize.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact text to append, in the user\'s words.' },
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      },
      required: ['text'],
    },
    execute: async ({ text, date }) => {
      if (!text || !text.trim()) throw new Error('text is required');
      const target = await journal.resolveDate(date);
      const entry = await journal.appendJournal(target, text.trim(), { source: 'voice' });
      return {
        ok: true,
        date: target,
        segments: entry.segments.length,
        summary: `Added to daily log for ${target}.`,
      };
    },
  },

  {
    name: 'daily_log_read',
    description:
      'Read back the full content of a Daily Log entry aloud. Use when the user says "read me my daily log", "what did I write today?", "play back yesterday\'s log". Defaults to today. Returns content so the LLM can read it verbatim — do NOT summarize, speak the content as-is.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      },
    },
    execute: async ({ date } = {}, ctx = {}) => {
      const target = await journal.resolveDate(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      const entry = await journal.getJournal(target);
      if (!entry || !entry.content?.trim()) {
        return { ok: true, date: target, empty: true, summary: `Daily log for ${target} is empty.` };
      }
      // Keep `summary` short — tool results are JSON-stringified into the
      // LLM message history, and duplicating the full content here would
      // double the token cost of every subsequent turn for no benefit.
      // Content is returned once in `content`.
      return {
        ok: true,
        date: target,
        content: entry.content,
        segments: entry.segments?.length || 0,
        summary: `Daily log for ${target} (${entry.segments?.length || 0} segments).`,
      };
    },
  },
];
