/**
 * "Ask Yourself" Routes
 *
 *   GET    /api/ask                       → list conversations (summaries)
 *   GET    /api/ask/:id                   → full conversation
 *   POST   /api/ask                       → SSE-stream a new turn (creates a
 *                                            conversation if no `id` in body)
 *   DELETE /api/ask/:id                   → delete a conversation
 *   POST   /api/ask/:id/promote           → mark conversation exempt from
 *                                            30-day auto-expiry
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as convs from '../services/askConversations.js';
import { runAsk, VALID_MODES } from '../services/askService.js';

const router = Router();

// How many prior turns to include when assembling the prompt. The persisted
// conversation file keeps everything; trimming here keeps the prompt bounded
// against multi-turn token blowup.
const PROMPT_HISTORY_TURNS = 12;

const idSchema = z.string().regex(/^ask_[a-z0-9]+_[a-f0-9]+$/, 'invalid conversation id');

const askBodySchema = z.object({
  conversationId: idSchema.optional(),
  question: z.string().trim().min(1).max(4000),
  mode: z.enum([...VALID_MODES]).optional().default('ask'),
  providerId: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  maxSources: z.number().int().min(1).max(50).optional().default(12),
  timeWindow: z.object({
    days: z.number().int().min(1).max(365).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }).optional(),
});

const promoteBodySchema = z.object({
  promoted: z.boolean().optional().default(true),
});

router.get('/', asyncHandler(async (_req, res) => {
  const conversations = await convs.listConversations({ limit: 100 });
  res.json({ conversations });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const conv = await convs.getConversation(String(req.params.id));
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ conversation: conv });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const removed = await convs.deleteConversation(String(req.params.id));
  if (!removed) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ ok: true });
}));

router.post('/:id/promote', asyncHandler(async (req, res) => {
  const { promoted } = validateRequest(promoteBodySchema, req.body ?? {});
  const conv = await convs.setPromoted(String(req.params.id), promoted);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ conversation: conv });
}));

// Stream a new turn over SSE. Body { conversationId?, question, mode?, ... }.
// If no conversationId, a new conversation is created and its id is
// surfaced in the first SSE event so the client can deep-link.
router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(askBodySchema, req.body ?? {});

  let conversation = body.conversationId
    ? await convs.getConversation(body.conversationId)
    : null;
  if (body.conversationId && !conversation) {
    throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  }
  if (!conversation) {
    conversation = await convs.createConversation({ mode: body.mode, title: body.question });
  }

  // Persist the user turn before streaming so a mid-stream disconnect still
  // leaves the question on disk — the user can reopen the conversation and
  // see their own question waiting.
  const { conversation: afterUser } = await convs.appendTurn(conversation.id, {
    role: 'user',
    content: body.question,
    mode: body.mode,
  });
  conversation = afterUser;

  // SSE handshake.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Propagate client disconnects (browser nav, tab close, abort) into
  // retrieval + provider streaming so we don't keep burning tokens/CPU on
  // a stream nobody's reading. `aborted` short-circuits the post-loop
  // persistence too.
  const abortController = new AbortController();
  let aborted = false;
  const onClose = () => {
    aborted = true;
    abortController.abort();
  };
  req.on('close', onClose);

  const send = (event, data) => {
    if (aborted) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Tell the client the conversation id up-front so it can deep-link the URL
  // before the answer finishes streaming.
  send('open', { conversationId: conversation.id, mode: body.mode });

  // Drop the just-appended user turn (we're about to answer it) plus take
  // the last PROMPT_HISTORY_TURNS prior turns as multi-turn context.
  const history = (conversation.turns || []).slice(-(PROMPT_HISTORY_TURNS + 1), -1);

  let assistantText = '';
  let assistantSources = [];
  let providerInfo = {};

  let streamErrored = false;
  for await (const evt of runAsk({
    question: body.question,
    mode: body.mode,
    history,
    timeWindow: body.timeWindow,
    maxSources: body.maxSources,
    providerId: body.providerId,
    model: body.model,
    signal: abortController.signal,
  })) {
    if (aborted) break;
    if (evt.type === 'sources') {
      assistantSources = evt.sources;
      send('sources', { sources: evt.sources });
    } else if (evt.type === 'delta') {
      assistantText += evt.text;
      send('delta', { text: evt.text });
    } else if (evt.type === 'done') {
      providerInfo = { providerId: evt.providerId, model: evt.model };
      // Streaming providers accumulate via delta events; one-shot CLI
      // providers report the full answer once at 'done'.
      if (!assistantText && evt.answer) assistantText = evt.answer;
    } else if (evt.type === 'error') {
      streamErrored = true;
      send('error', { error: evt.error });
    }
  }

  req.off('close', onClose);

  // If the client bailed mid-stream we still persist whatever assistant text
  // we accumulated so the conversation isn't silently lossy on reconnect,
  // but we don't try to write any more SSE frames to a dead socket.
  let persistedAssistantTurn = null;
  if (!streamErrored && assistantText) {
    const result = await convs.appendTurn(conversation.id, {
      role: 'assistant',
      content: assistantText,
      sources: assistantSources,
      mode: body.mode,
      ...providerInfo,
    });
    persistedAssistantTurn = result.turn;
  }

  if (!aborted) {
    // Hand back the persisted turn so the client can append to local state
    // instead of round-tripping a full conversation refetch.
    send('done', { conversationId: conversation.id, turn: persistedAssistantTurn });
    res.end();
  }
}));

export default router;
