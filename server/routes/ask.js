/**
 * "Ask Yourself" Routes
 *
 *   GET    /api/ask                       → list conversations (summaries)
 *   GET    /api/ask/:id                   → full conversation
 *   POST   /api/ask                       → SSE-stream a new turn (creates a
 *                                            conversation if no `conversationId`
 *                                            in body)
 *   DELETE /api/ask/:id                   → delete a conversation
 *   POST   /api/ask/:id/promote           → mark conversation exempt from
 *                                            30-day auto-expiry
 *   POST   /api/ask/:id/turns/:turnId/promote
 *                                         → one-click promote an assistant
 *                                            turn into a Brain note / CoS
 *                                            task / Goal progress entry; also
 *                                            pins the conversation so it
 *                                            survives the 30-day expiry once
 *                                            anything from it has been saved.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as convs from '../services/askConversations.js';
import { runAsk, VALID_MODES } from '../services/askService.js';
import { ID_RE as CONV_ID_RE } from '../services/askConversations.js';
import * as brainService from '../services/brain.js';
import * as cosService from '../services/cos.js';
import * as identityService from '../services/identity.js';

const router = Router();

// How many prior turns to include when assembling the prompt. The persisted
// conversation file keeps everything; trimming here keeps the prompt bounded
// against multi-turn token blowup.
const PROMPT_HISTORY_TURNS = 12;

// Sourced from `askConversations.ID_RE` so the route, the storage layer, and
// the generator are guaranteed to agree on the canonical id shape — variable-
// width regexes here let non-canonical ids through and break listConversations'
// lexical-sort = chronological-sort invariant.
const idSchema = z.string().regex(CONV_ID_RE, 'invalid conversation id');

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
  }).refine(
    (w) => !(w.startDate && w.endDate) || Date.parse(w.startDate) <= Date.parse(w.endDate),
    { message: 'startDate must be <= endDate', path: ['startDate'] },
  ).optional(),
});

const promoteBodySchema = z.object({
  promoted: z.boolean().optional().default(true),
});

// Promote-turn payloads vary by target — keep the discriminated union narrow
// rather than a permissive bag so the route can fail-fast on a goal target
// missing its goalId before we touch any service.
const promoteTurnBodySchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('brain') }),
  z.object({ target: z.literal('task'), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().default('MEDIUM') }),
  z.object({ target: z.literal('goal'), goalId: z.string().min(1).max(200) }),
]);

// Cap promoted task descriptions so a long assistant answer doesn't bloat
// TASKS.md — the full text is still in the conversation. CoS tasks are
// supposed to be one-line directives, not essays.
const TASK_DESCRIPTION_MAX = 280;

router.get('/', asyncHandler(async (_req, res) => {
  const conversations = await convs.listConversations({ limit: 100 });
  res.json({ conversations });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(idSchema, String(req.params.id));
  const conv = await convs.getConversation(id);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ conversation: conv });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const id = validateRequest(idSchema, String(req.params.id));
  const removed = await convs.deleteConversation(id);
  if (!removed) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ ok: true });
}));

router.post('/:id/promote', asyncHandler(async (req, res) => {
  const id = validateRequest(idSchema, String(req.params.id));
  const { promoted } = validateRequest(promoteBodySchema, req.body ?? {});
  const conv = await convs.setPromoted(id, promoted);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ conversation: conv });
}));

// One-click promote an assistant turn into a Brain note, CoS task, or Goal
// progress entry. Always sets the conversation `promoted` flag so anything
// the user has saved elsewhere survives the 30-day expiry sweep.
router.post('/:id/turns/:turnId/promote', asyncHandler(async (req, res) => {
  const id = validateRequest(idSchema, String(req.params.id));
  const turnId = String(req.params.turnId || '');
  if (!turnId) throw new ServerError('turnId is required', { status: 400, code: 'VALIDATION_ERROR' });

  const body = validateRequest(promoteTurnBodySchema, req.body ?? {});

  const conv = await convs.getConversation(id);
  if (!conv) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const turn = (conv.turns || []).find((t) => t.id === turnId);
  if (!turn) throw new ServerError('Turn not found', { status: 404, code: 'NOT_FOUND' });
  // Only assistant turns carry promotable content — the user's question is
  // already implicit in the conversation and would just bloat the brain inbox
  // / task list with prompts, not insights.
  if (turn.role !== 'assistant') {
    throw new ServerError('Only assistant turns can be promoted', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const content = (turn.content || '').trim();
  if (!content) {
    throw new ServerError('Turn has no content to promote', { status: 400, code: 'EMPTY_CONTENT' });
  }

  let ref;
  if (body.target === 'brain') {
    const result = await brainService.captureThought(content);
    ref = { type: 'brain', id: result?.inboxLog?.id };
  } else if (body.target === 'task') {
    // Trim the description so the line in TASKS.md stays scannable; tag
    // the source so the user can trace a task back to where it came from.
    const description = content.length <= TASK_DESCRIPTION_MAX
      ? content
      : `${content.slice(0, TASK_DESCRIPTION_MAX - 1)}…`;
    const result = await cosService.addTask({
      description,
      priority: body.priority,
      context: `Promoted from Ask Yourself conversation ${id}`,
    }, 'user');
    if (result?.duplicate) {
      throw new ServerError('A task with this description is already pending', { status: 409, code: 'DUPLICATE_TASK' });
    }
    ref = { type: 'task', id: result?.id };
  } else if (body.target === 'goal') {
    const today = new Date().toISOString().slice(0, 10);
    const entry = await identityService.addProgressEntry(body.goalId, {
      date: today,
      note: content,
      durationMinutes: null,
    });
    if (!entry) throw new ServerError('Goal not found', { status: 404, code: 'NOT_FOUND' });
    ref = { type: 'goal', id: body.goalId, entryId: entry.id };
  }

  // Pin the conversation so anything the user has promoted survives the
  // 30-day auto-expiry sweep — without this, a saved brain note could
  // outlive the conversation it cites.
  const conversation = await convs.setPromoted(id, true);
  res.json({ ok: true, target: body.target, ref, conversation });
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
  // provider streaming and the post-retrieval generator loop so we don't
  // keep burning tokens/CPU on a stream nobody's reading. The retrieval
  // fan-out itself doesn't currently take a signal — those queries are
  // bounded (~hundreds of ms) so we let them finish; once retrieval
  // returns, the abort short-circuits before any further SSE writes or
  // provider work. `aborted` also gates further SSE writes (the socket is
  // dead) but we still persist whatever assistant text was accumulated up
  // to that point so the conversation isn't lossy on reconnect.
  const abortController = new AbortController();
  let aborted = false;
  const onClose = () => {
    aborted = true;
    abortController.abort();
  };
  req.on('close', onClose);

  // Honour socket backpressure — for long answers with many delta frames,
  // a slow reader could otherwise force Node to buffer unbounded SSE data
  // in memory. If `res.write` returns false, await the next `drain` (or
  // `close`) before queuing more frames. Both listeners are torn down on
  // settle so a slow client that disconnects mid-drain doesn't leak
  // listeners.
  //
  // Guard the write itself: between the `aborted` check and the syscall,
  // the socket can transition to destroyed, in which case `res.write` would
  // throw `ERR_STREAM_WRITE_AFTER_END`. Treat any throw as an abort so the
  // disconnect doesn't bubble out as a 500 after we've already flushed
  // SSE headers (which would also surface as ERR_HTTP_HEADERS_SENT noise).
  const send = async (event, data) => {
    if (aborted || res.writableEnded || res.destroyed) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let writeOk;
    try {
      writeOk = res.write(frame);
    } catch {
      onClose();
      return;
    }
    if (!writeOk) {
      await new Promise((resolve) => {
        const settle = () => {
          res.off('drain', settle);
          res.off('close', settle);
          resolve();
        };
        res.once('drain', settle);
        res.once('close', settle);
      });
    }
  };

  // Tell the client the conversation id up-front so it can deep-link the URL
  // before the answer finishes streaming.
  await send('open', { conversationId: conversation.id, mode: body.mode });

  // Drop the just-appended user turn (we're about to answer it) plus take
  // the last PROMPT_HISTORY_TURNS prior turns as multi-turn context.
  const history = (conversation.turns || []).slice(-(PROMPT_HISTORY_TURNS + 1), -1);

  // Accumulate deltas into an array and join once at the end; `+=` would be
  // O(n²) on long answers where each chunk reallocates the running string.
  // Mirrors `askService.runAsk`'s producer-side pattern.
  const assistantChunks = [];
  let assistantFallback = '';
  let assistantSources = [];
  let providerInfo = {};

  // From here on, headers are flushed and the stream is "in SSE mode" —
  // any thrown error must convert to a terminal SSE `error` frame instead
  // of being thrown to asyncHandler (which would try to send a JSON 500
  // body and trigger ERR_HTTP_HEADERS_SENT). The try/finally guarantees
  // the close listener is detached even on a thrown path.
  let streamErrored = false;
  try {
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
        await send('sources', { sources: evt.sources });
      } else if (evt.type === 'delta') {
        assistantChunks.push(evt.text);
        await send('delta', { text: evt.text });
      } else if (evt.type === 'done') {
        providerInfo = { providerId: evt.providerId, model: evt.model };
        // Both API and CLI providers stream their text via `delta` events
        // (CLI providers yield a single big chunk). The terminal `done`
        // event also carries the full answer as a defensive fallback —
        // capture it only if no deltas arrived.
        if (assistantChunks.length === 0 && evt.answer) assistantFallback = evt.answer;
      } else if (evt.type === 'error') {
        streamErrored = true;
        await send('error', { error: evt.error });
      }
    }

    const assistantText = assistantChunks.length ? assistantChunks.join('') : assistantFallback;

    // If the client bailed mid-stream we still persist whatever assistant
    // text we accumulated so the conversation isn't silently lossy on
    // reconnect — but a write failure here must not bubble out either.
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
      if (streamErrored) {
        // Error event already flushed inside the loop — close the stream
        // without a `done` frame so clients can cleanly distinguish
        // failure (terminal `error`) from success (terminal `done`).
      } else {
        // Hand back the persisted turn so the client can append to local
        // state instead of round-tripping a full conversation refetch.
        await send('done', { conversationId: conversation.id, turn: persistedAssistantTurn });
      }
    }
  } catch (err) {
    streamErrored = true;
    console.error(`❌ Ask SSE handler error: ${err?.message || err}`);
    await send('error', { error: err?.message || 'internal error' }).catch(() => {});
  } finally {
    req.off('close', onClose);
    // Guard both `writableEnded` AND `destroyed` — if the client disconnected
    // mid-stream the underlying socket may already be torn down, and calling
    // `res.end()` on a destroyed stream throws an unhandled write error.
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}));

export default router;
