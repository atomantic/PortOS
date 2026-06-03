// Brain-inbox voice tools: capture / search / read-recent. Each entry is an
// OpenAI-format function schema plus an execute() that runs the action; the
// orchestrator (tools.js) collects them into the shared TOOLS registry.

import { captureThought, getInboxLog } from '../../brain.js';
import { clampLimit } from './shared.js';

// Expanded to cover natural capture verbs — "remember", "note", "save",
// "jot", "file" — without which moving brain_capture out of the always-on
// set would break "remember to buy milk" style turns.
export const BRAIN_INTENT_RE = /\b(search|find|look ?up|recall|what did I (?:say|write|note)|brain|inbox|capture|remember|remind me|jot|note (?:that|to|down)|save (?:this|that)|file (?:this|that|it)|add (?:this|that|it) to (?:my )?(?:brain|inbox|notes?))\b/i;

export const BRAIN_TOOLS = [
  {
    name: 'brain_capture',
    description:
      'Capture a thought, note, idea, todo, reminder, or any free-form information to the user\'s brain inbox for later classification. Use whenever the user asks you to remember, add, save, note, or jot something down. The text should be in the user\'s own words with enough detail that it\'s useful later.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The content to capture, phrased naturally. Include who/what/when/why details if the user mentioned them.',
        },
      },
      required: ['text'],
    },
    execute: async ({ text }) => {
      if (!text || typeof text !== 'string') throw new Error('text is required');
      const trimmed = text.trim();
      if (!trimmed) throw new Error('text must not be empty');
      // captureThought returns { inboxLog, message } — the inbox record id
      // lives inside inboxLog; returning `entry.id` was `undefined`.
      const { inboxLog } = await captureThought(trimmed);
      return {
        ok: true,
        id: inboxLog?.id,
        summary: `Captured "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`,
      };
    },
  },

  {
    name: 'brain_search',
    description:
      'Search the user\'s brain inbox for previously captured thoughts, notes, or ideas. Use when the user asks "what did I say about X?", "do I have any notes on Y?", or wants to recall something they captured earlier. Returns up to 5 matching entries with their capture text and date.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for in captured text (case-insensitive). Use the most distinctive keyword the user mentioned.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 5, max 10).',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, limit = 5 }) => {
      if (!query || typeof query !== 'string') throw new Error('query is required');
      const q = query.trim().toLowerCase();
      // `String.includes('')` matches everything, so an all-whitespace query
      // would return unrelated entries — reject instead of surprising the user.
      if (!q) throw new Error('query must not be empty');
      const max = clampLimit(limit, 5, 10);
      // Load a reasonable window — the brain inbox is small enough that an
      // in-memory filter is fine and avoids a second storage pass for ranking.
      const records = await getInboxLog({ limit: 200 });
      const hits = records
        .filter((r) => (r.capturedText || '').toLowerCase().includes(q))
        .slice(0, max)
        .map((r) => ({
          id: r.id,
          date: (r.capturedAt || '').slice(0, 10),
          text: r.capturedText,
        }));
      return {
        ok: true,
        count: hits.length,
        hits,
        summary: hits.length
          ? `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"`
          : `No captures matched "${query}"`,
      };
    },
  },

  {
    name: 'brain_list_recent',
    description:
      'Read back the user\'s most recently captured brain-inbox entries. Use when they ask "what are my last notes?", "read me my recent captures", "what did I jot down today?".',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many entries to return (default 5, max 10).',
        },
      },
    },
    execute: async ({ limit = 5 } = {}) => {
      const max = clampLimit(limit, 5, 10);
      const records = await getInboxLog({ limit: max });
      const items = records.map((r) => ({
        date: (r.capturedAt || '').slice(0, 10),
        text: r.capturedText,
      }));
      return {
        ok: true,
        count: items.length,
        items,
        summary: items.length
          ? `Last ${items.length} capture${items.length === 1 ? '' : 's'}.`
          : 'Brain inbox is empty.',
      };
    },
  },
];
