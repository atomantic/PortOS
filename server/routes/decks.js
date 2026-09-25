/**
 * Decks routes — playing-card / tarot deck designer (Create → Decks).
 *
 * CRUD on the deck + its cards, the stateless sample-design analysis
 * (vision → proposed style guide, persisted only through `/samples`), the
 * casting + prompt-writing pass, and single/batch card rendering through the
 * shared media queue.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  deckAddSampleSchema,
  deckAnalyzeSampleSchema,
  deckCardUpdateSchema,
  deckCreateSchema,
  deckGeneratePromptsSchema,
  deckRenderSchema,
  deckUpdateSchema,
} from '../lib/deckValidation.js';
import { resolveGalleryImageOrThrow } from './universeBuilder/shared.js';
import { resolveLlmRoutePin } from '../lib/llmRoutePin.js';
import { attachClient as attachPromptProgressClient, beginPromptProgress, emitPromptProgress, finishPromptProgress } from '../services/deckPromptProgress.js';

// Services load on first request, not at route-module import: the deck graph
// reaches the DB, the prompt runner and the media queue, none of which a
// route-only consumer needs instantiated (server/AGENTS.md "Import scoping").
const decks = () => import('../services/decks.js');
const styleAnalysis = () => import('../services/deckStyleAnalysis.js');
const prompts = () => import('../services/deckPrompts.js');
const render = () => import('../services/deckRender.js');

const router = Router();

// Ids are UUIDs minted by the service; validating up front turns a malformed
// id into a 400 instead of a Postgres cast error surfacing as a 500.
const deckParams = z.object({ id: z.uuid() });
const cardParams = deckParams.extend({ cardId: z.uuid() });
const sampleParams = deckParams.extend({ sampleId: z.string().trim().min(1).max(200) });
const deckId = (req) => validateRequest(deckParams, req.params).id;
const cardIds = (req) => validateRequest(cardParams, req.params);

router.get('/', asyncHandler(async (_req, res) => {
  const { listDecks } = await decks();
  res.json(await listDecks());
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(deckCreateSchema, req.body ?? {});
  const { createDeck } = await decks();
  res.status(201).json(await createDeck(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { getDeck } = await decks();
  res.json(await getDeck(deckId(req)));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(deckUpdateSchema, req.body ?? {});
  const { updateDeck } = await decks();
  res.json(await updateDeck(deckId(req), body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { deleteDeck } = await decks();
  res.json(await deleteDeck(deckId(req)));
}));

router.patch('/:id/cards/:cardId', asyncHandler(async (req, res) => {
  const { id, cardId } = cardIds(req);
  const body = validateRequest(deckCardUpdateSchema, req.body ?? {});
  const { updateCard } = await decks();
  res.json(await updateCard(id, cardId, body));
}));

// Stateless review step: analyze a gallery image against the deck's current
// style guide and return a proposal + diff. Persistence happens through
// POST /:id/samples once the user picks "add" or "adopt + add".
router.post('/:id/analyze-sample', asyncHandler(async (req, res) => {
  const body = validateRequest(deckAnalyzeSampleSchema, req.body ?? {});
  const [{ getDeck }, { analyzeDeckSample }] = await Promise.all([decks(), styleAnalysis()]);
  const deck = await getDeck(deckId(req));
  const { imageFilename, imagePath } = resolveGalleryImageOrThrow(body.image);
  // Vision needs an image-capable API provider, which the deck's prompt pin
  // (a text job) need not be — so the picker in the modal is the only source.
  res.json(await analyzeDeckSample({
    deck, imagePath, imageFilename, title: body.title,
    providerId: body.providerId || undefined, model: body.model || undefined, effort: body.effort || undefined,
  }));
}));

router.post('/:id/samples', asyncHandler(async (req, res) => {
  const body = validateRequest(deckAddSampleSchema, req.body ?? {});
  const { addSample } = await decks();
  res.json(await addSample(deckId(req), body.sample, { adopt: body.adopt }));
}));

router.delete('/:id/samples/:sampleId', asyncHandler(async (req, res) => {
  const { id, sampleId } = validateRequest(sampleParams, req.params);
  const { removeSample } = await decks();
  res.json(await removeSample(id, sampleId));
}));

// Casting (universe-linked decks) + prompt writing in one user action. The
// casting pass runs only when a universe is linked, `cast` is on, and at least
// one targeted card is still uncast — so re-running to fill new prompts doesn't
// re-shuffle an assignment the user already accepted.
router.post('/:id/generate-prompts', asyncHandler(async (req, res) => {
  const body = validateRequest(deckGeneratePromptsSchema, req.body ?? {});
  const [{ getDeck, applyCardGenerations }, { castDeckFromUniverse, generateDeckCardPrompts, PROMPTS_PER_CALL }] = await Promise.all([decks(), prompts()]);
  const deck = await getDeck(deckId(req));
  // Per-call choice over the deck's stored pin; a provider switch drops the
  // pinned model/effort rather than carrying them across providers.
  const { providerId, model, effort } = resolveLlmRoutePin(deck.promptLlm, body);
  const llm = { providerId: providerId || undefined, model: model || undefined, effort: effort || undefined };
  const wanted = Array.isArray(body.cardIds) && body.cardIds.length ? new Set(body.cardIds) : null;
  let roster = deck.cards;
  const targetIds = new Set(roster.filter((c) => (!wanted || wanted.has(c.id)) && (body.overwrite || !c.prompt)).map((c) => c.id));
  if (!targetIds.size) {
    throw new ServerError('Every selected card already has a prompt — enable overwrite to rewrite them.', {
      status: 400, code: 'DECK_NO_PROMPT_TARGETS',
    });
  }

  // Live progress for this run (see services/deckPromptProgress.js).
  // The GET may arrive before or after this POST. Reserve the channel here so
  // every emitted frame is retained for a late subscriber; generation is still
  // advisory and never waits on an SSE client.
  const emit = (payload) => emitPromptProgress(deck.id, payload);
  const finish = (payload) => finishPromptProgress(deck.id, payload);

  let universe = null;
  let cast = null;
  try {
    beginPromptProgress(deck.id);
    if (deck.universeId) {
      const { getUniverse } = await import('../services/universeBuilder.js');
      universe = await getUniverse(deck.universeId).catch(() => null);
      if (universe && body.cast && roster.some((c) => targetIds.has(c.id) && !c.canonRef)) {
        emit({ type: 'phase', deckId: deck.id, phase: 'casting', label: 'Casting the universe onto the cards…' });
        cast = await castDeckFromUniverse({ deck, cards: roster, universe, ...llm });
        // Only cards not yet cast take an assignment; a user-accepted link stays.
        const uncast = new Set(roster.filter((c) => !c.canonRef).map((c) => c.id));
        const applied = new Map(cast.assignments.filter((a) => uncast.has(a.cardId)).map((a) => [a.cardId, a.canonRef]));
        await applyCardGenerations(deck.id, [...applied].map(([cardId, canonRef]) => ({ cardId, canonRef })));
        roster = roster.map((c) => (applied.has(c.id) ? { ...c, canonRef: applied.get(c.id) } : c));
        emit({ type: 'phase', deckId: deck.id, phase: 'cast', label: 'Casting done — writing prompts…', assigned: cast.assignments.filter((a) => a.canonRef).length });
      }
    }
    const targets = roster.filter((c) => targetIds.has(c.id));
    const perCall = Number.isFinite(PROMPTS_PER_CALL) && PROMPTS_PER_CALL > 0 ? PROMPTS_PER_CALL : 12;
    const chunks = Math.max(1, Math.ceil(targets.length / perCall));
    emit({ type: 'start', deckId: deck.id, requested: targets.length, chunks, at: new Date().toISOString() });

    // Prompts persist chunk by chunk, so a chunk that fails mid-deck (a model
    // that returns bad JSON on its third call) leaves the earlier cards written.
    let appliedCount = 0;
    let chunkIndex = 0;
    const byId = new Map(targets.map((c) => [c.id, c]));
    const generated = await generateDeckCardPrompts({
      deck, roster, targets, universe, ...llm,
      onChunk: async (chunk) => {
        appliedCount += await applyCardGenerations(deck.id, chunk);
        chunkIndex += 1;
        emit({
          type: 'chunk', deckId: deck.id, chunk: chunkIndex, chunks,
          written: appliedCount, requested: targets.length,
          keys: chunk.map((e) => byId.get(e.cardId)?.key || null).filter(Boolean),
        });
      },
    });
    finish({
      type: 'complete', deckId: deck.id, written: appliedCount, requested: targets.length,
      completedAt: new Date().toISOString(),
    });
    res.json({
      deck: await getDeck(deck.id),
      written: appliedCount,
      requested: targets.length,
      cast: cast ? cast.assignments.filter((a) => a.canonRef).length : 0,
      llm: generated.llm,
    });
  } catch (error) {
    finish({ type: 'error', deckId: deck.id, error: (error?.message || String(error)).slice(0, 1000) });
    throw error;
  }
}));

// Live progress for the POST above. Attaching OPENS the channel, so the
// client can subscribe before (or concurrently with) the generate POST
// without racing it — and generation runs unchanged when nobody listens.
router.get('/:id/generate-prompts/progress', (req, res) => {
  attachPromptProgressClient(deckId(req), res);
});

router.post('/:id/render', asyncHandler(async (req, res) => {
  const body = validateRequest(deckRenderSchema, req.body ?? {});
  const { renderDeckCards } = await render();
  res.json(await renderDeckCards(deckId(req), body));
}));

router.post('/:id/cards/:cardId/render', asyncHandler(async (req, res) => {
  const { id, cardId } = cardIds(req);
  const body = validateRequest(deckRenderSchema.omit({ cardIds: true, onlyMissing: true }), req.body ?? {});
  const { renderDeckCards } = await render();
  res.json(await renderDeckCards(id, { ...body, cardIds: [cardId] }));
}));

export default router;
