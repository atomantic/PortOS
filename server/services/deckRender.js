/**
 * Deck rendering — queue one image job per card through the shared media
 * queue, tagged `deckCard` so `deckRenderHook` files the finished gallery
 * image back onto the card even when no client is watching.
 *
 * The backend resolves through the render-target ladder
 * (`RENDER_TARGET.DECK`): per-request mode → the deck's own `imageMode` /
 * `imageModelId` pin → Settings → Image Gen "Deck card renders" default →
 * the install-wide mode. Batch rendering against the synchronous `external`
 * SD-API backend is rejected up front, as the universe batch renderer does.
 */

import { IMAGE_GEN_MODE, QUEUEABLE_IMAGE_MODES } from '../lib/generationModes.js';
import { RENDER_TARGET, recordRenderPin } from '../lib/renderTargets.js';
import { composeCardRenderPrompt } from '../lib/deckTemplates.js';
import { ServerError } from '../lib/errorHandler.js';
import { getDeck, markCardsRenderQueued } from './decks.js';

/**
 * Select which cards a render request covers: an explicit id list, else every
 * card; `onlyMissing` drops cards that already have an image. Cards with no
 * prompt are always skipped — a blank subject would render the layout clause
 * alone, and the client shows them as "needs a prompt".
 */
export function selectCardsToRender(cards, { cardIds, onlyMissing = false } = {}) {
  const wanted = Array.isArray(cardIds) && cardIds.length ? new Set(cardIds) : null;
  return cards.filter((card) => {
    if (wanted && !wanted.has(card.id)) return false;
    if (!card.prompt) return false;
    if (onlyMissing && card.imageRefs.length) return false;
    return true;
  });
}

/**
 * @returns {Promise<{ mode, jobs: [{ cardId, key, jobId }], skipped: number }>}
 */
export async function renderDeckCards(deckId, { cardIds, onlyMissing = false, mode: requestedMode, model, seed } = {}) {
  // The queue, settings and image-gen dispatcher load on the first render
  // request — this module is reached by the route + hook graphs, which never
  // need them instantiated (server/AGENTS.md "Import scoping").
  const [
    { enqueueJob }, { getSettings }, { resolveRenderTargetConfig }, { resolveLocalImageModel }, { resolveImageCleaners },
  ] = await Promise.all([
    import('./mediaJobQueue/index.js'), import('./settings.js'), import('./imageGen/cloudProviderConfig.js'),
    import('./imageGen/prepareParams.js'), import('./imageGen/index.js'),
  ]);
  const deck = await getDeck(deckId);
  const targets = selectCardsToRender(deck.cards, { cardIds, onlyMissing });
  if (!targets.length) {
    throw new ServerError('No cards to render — write or generate prompts first.', { status: 400, code: 'DECK_NO_RENDERABLE_CARDS' });
  }

  const settings = await getSettings();
  const pin = recordRenderPin(deck);
  const { mode, cloud } = resolveRenderTargetConfig(settings, RENDER_TARGET.DECK, {
    mode: requestedMode,
    model,
    recordMode: pin.mode,
    recordModel: pin.modelId,
    fallbackMode: IMAGE_GEN_MODE.EXTERNAL,
  });
  if (!QUEUEABLE_IMAGE_MODES.includes(mode)) {
    throw new ServerError(
      'Deck rendering requires a queueable image backend (local, codex, grok or agy) — pin one on the deck or in Settings → Image Gen',
      { status: 400, code: 'DECK_EXTERNAL_UNSUPPORTED' },
    );
  }
  if (cloud && !cloud.enabled) throw cloud.disabledError;
  const localPinModel = (!pin.mode || pin.mode === IMAGE_GEN_MODE.LOCAL)
    ? pin.modelId
    : null;
  const localModel = mode === IMAGE_GEN_MODE.LOCAL
    ? resolveLocalImageModel(settings, { modelId: model || localPinModel || undefined })
    : null;
  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);

  const jobs = [];
  const stamps = [];
  for (const card of targets) {
    const { prompt, negativePrompt } = composeCardRenderPrompt(deck, card);
    const base = {
      prompt,
      negativePrompt: negativePrompt || undefined,
      width: deck.cardSize.width,
      height: deck.cardSize.height,
      ...(seed != null ? { seed } : {}),
      cleanC2PA,
      denoise,
      // Destination tag the completion hook files the render by.
      deckCard: { deckId: deck.id, cardId: card.id, key: card.key },
    };
    const params = cloud
      ? { ...cloud.jobParams, ...base }
      : {
        mode,
        pythonPath: localModel?.pythonPath || null,
        ...(localModel?.selectedModel?.id ? { modelId: localModel.selectedModel.id } : {}),
        ...base,
      };
    const { jobId } = enqueueJob({ kind: 'image', params, owner: 'decks' });
    jobs.push({ cardId: card.id, key: card.key, jobId });
    stamps.push({ cardId: card.id, render: {
      jobId, status: 'queued', queuedAt: new Date().toISOString(), mode,
      model: cloud?.modelId || localModel?.selectedModel?.id || null, error: null,
    } });
  }
  // One statement for the whole batch; a job the hook already filed keeps its
  // completed record (the stamp skips a matching jobId).
  await markCardsRenderQueued(deck.id, stamps);
  console.log(`🃏 deck render "${deck.name}": ${jobs.length} card(s) queued mode=${mode}`);
  return { mode, jobs, skipped: deck.cards.length - targets.length };
}
