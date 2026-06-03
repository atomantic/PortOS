// Digital-twin RAG voice tool (ui_ask): cross-domain recall over Brain, Memory,
// Goals, Calendar, and Autobiography via askService. Tight intent gating — the
// tool consumes a full LLM stream, so it shouldn't steal turns the cheaper tools
// can handle.

import { runAsk, VALID_MODES as ASK_VALID_MODES } from '../../askService.js';

// RAG questions answered by askService — phrasings that need cross-domain
// recall (Brain + Memory + Goals + Calendar + Autobiography). Tight on
// purpose: the tool is large (consumes a full LLM stream) and we don't
// want it stealing turns the cheaper tools handle. Catches "advise me",
// "draft a/an X", "what did I decide", "what's on my plate", "ask myself".
export const ASK_INTENT_RE = /\b(?:ask my ?self|advise me|coach me|draft (?:a|an|my|me|something)|what(?:'s| is) on my plate|what (?:did|do|should) i (?:decide|think|believe|say|want|do)|why did i|when did i|recall (?:my|that|when))\b/i;

export const ASK_TOOLS = [
  {
    name: 'ui_ask',
    description:
      'Ask the user\'s digital twin a question that needs retrieval-augmented recall across their Brain (notes, ideas, projects, inbox), Memory (semantic + BM25), Goals, Calendar, and Autobiography. Use for cross-domain questions the cheaper tools cannot answer: ' +
      '"what did I decide about X?", "advise me on Y given my goals", "draft a status update as me", "what\'s on my plate this afternoon?", "why did I prioritize Z?". ' +
      'NOT for one-shot lookups (use brain_search / goal_list / feeds_digest / time_now); NOT for capture verbs (use brain_capture / daily_log_append). ' +
      'The tool returns the answer in `content` — speak `content` directly without summarizing or rephrasing it. Skip citation markers like [1] [2] when reading aloud (they reference source chips on the Ask page).',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The user\'s question, in their own words. Pass through the substantive question — strip leading filler like "hey, can you" but keep the actual content.',
        },
        mode: {
          type: 'string',
          enum: ['ask', 'advise', 'draft'],
          description: '"ask" answers as the user (default). "advise" answers as a coach who knows the user. "draft" produces text in the user\'s voice for an external recipient (use for "draft a Slack message", "write an email as me").',
        },
      },
      required: ['question'],
    },
    execute: async ({ question, mode = 'ask' } = {}, ctx = {}) => {
      if (typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
      }
      const trimmed = question.trim();
      const validMode = ASK_VALID_MODES.has(mode) ? mode : 'ask';
      const deltas = [];
      let doneAnswer = null;
      let sources = [];
      let providerId = null;
      let model = null;
      let errorMsg = null;
      // runAsk yields { sources, delta, done, error }. Collect deltas into an array
      // (avoids O(n²) string reallocation on long answers); the terminal `done` event
      // delivers the canonical full answer + reranked sources and supersedes deltas.
      for await (const evt of runAsk({ question: trimmed, mode: validMode, signal: ctx.signal })) {
        if (evt.type === 'sources') sources = evt.sources;
        else if (evt.type === 'delta') deltas.push(evt.text);
        else if (evt.type === 'error') { errorMsg = evt.error; break; }
        else if (evt.type === 'done') {
          doneAnswer = evt.answer;
          sources = evt.sources;
          providerId = evt.providerId;
          model = evt.model;
        }
      }
      if (errorMsg) {
        return { ok: false, error: errorMsg, summary: `I couldn't answer that — ${errorMsg}` };
      }
      // Barge-in: runAsk exits early on signal.aborted without emitting a `done`
      // event, so the loop ends with only partial deltas. Surface that as a
      // cancellation rather than a successful partial answer.
      if (ctx.signal?.aborted) {
        return { ok: false, error: 'aborted', summary: 'Cancelled before I could finish answering.' };
      }
      const finalAnswer = (doneAnswer ?? deltas.join('')).trim();
      if (!finalAnswer) {
        return { ok: false, summary: 'I came up empty on that question.' };
      }
      return {
        ok: true,
        content: finalAnswer,
        sourceCount: sources.length,
        sources: sources.map((s) => ({ kind: s.kind, title: s.title })),
        providerId,
        model,
        summary: `Answered "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}" using ${sources.length} source${sources.length === 1 ? '' : 's'}.`,
      };
    },
  },
];
