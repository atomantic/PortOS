/**
 * Environments › Photoreal look: AI dressing (materials, lights, atmosphere) for a
 * place's greybox, plus save/clear. Same contract as the greybox draft: runs only
 * on the user's tap with the provider › model › effort they picked, answers with a
 * PREVIEW and the exact prompt sent, and stores nothing until `savePhotorealLook`.
 * Each save is a catalog revision of the place, so earlier looks stay restorable.
 */

import { ServerError } from '../lib/errorHandler.js';
import { promptAddition } from '../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { resolveGreybox } from '../lib/greyboxScene.js';
import { greyboxPlaceBlock } from '../lib/greyboxPrompt.js';
import {
  parsePhotorealLookAnswer, photorealCurrentLookBlock, photorealGreyboxBlock, photorealLookContractInstructions,
  photorealLookPrompt, photorealLookReferenceErrors, resolvePhotorealLook,
} from '../lib/photorealLook.js';
import { CATALOG_PAYLOAD_MAX_CHARS } from '../lib/catalogValidation.js';
import * as catalogDB from './catalogDB.js';

const deps = {
  resolveProvider: async (args) => (await import('./promptRunner.js')).resolveProviderAndModel(args),
  runPrompt: async (args) => (await import('./promptRunner.js')).runPromptThroughProvider(args),
};
export const __setPhotorealLookDepsForTests = (overrides) => Object.assign(deps, overrides);

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

async function requireDressablePlace(ingredientId) {
  const place = await catalogDB.getIngredient(ingredientId);
  if (!place) throw refuse('Place not found', 'NOT_FOUND', 404);
  if (place.type !== 'place') throw refuse('A photoreal look belongs to a place', 'GREYBOX_NOT_A_PLACE');
  const scene = resolveGreybox(place.payload);
  if (!scene || scene.source !== 'spec') throw refuse('Save a greybox made of parts first; the look dresses its zones and parts.', 'GREYBOX_NOT_RENDERABLE', 422);
  return { place, scene };
}

// The one place the prompt is composed: preview and draft both call it.
function composeLookPrompt(place, scene, { instruction, useCurrent = true }) {
  const current = useCurrent ? resolvePhotorealLook(place.payload) : null;
  const instructions = photorealLookContractInstructions();
  const placeBlock = greyboxPlaceBlock({ name: place.name, description: place.payload?.description });
  const greyboxBlock = photorealGreyboxBlock(scene);
  const currentBlock = photorealCurrentLookBlock(current);
  const sentPrompt = withCreativeLatitude(photorealLookPrompt({ instructions, placeBlock, greyboxBlock, currentBlock, request: instruction }));
  const promptAdditions = [
    CREATIVE_LATITUDE_ADDITION,
    promptAddition('photoreal-contract', 'Photoreal look contract', instructions),
    promptAddition('greybox-place', 'Place', placeBlock),
    promptAddition('photoreal-greybox', 'Greybox zones and parts', greyboxBlock),
    promptAddition('photoreal-current', 'Current look', currentBlock),
  ].filter(Boolean);
  return { sentPrompt, promptAdditions, edited: Boolean(current) };
}

/** The exact prompt a draft would send, with no provider call. */
export async function previewPhotorealLookPrompt(ingredientId, { instruction, useCurrent = true }) {
  const { place, scene } = await requireDressablePlace(ingredientId);
  return composeLookPrompt(place, scene, { instruction, useCurrent });
}

export async function draftPhotorealLook(ingredientId, { instruction, providerId = '', model = '', effort = '', useCurrent = true }) {
  const { place, scene } = await requireDressablePlace(ingredientId);
  const { sentPrompt, promptAdditions, edited } = composeLookPrompt(place, scene, { instruction, useCurrent });
  const { provider, selectedModel } = await deps.resolveProvider({ providerId: providerId || null, model: model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one first.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) {
    throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');
  }
  const result = await deps.runPrompt({ provider, model: selectedModel, effort: effort || undefined, prompt: sentPrompt, source: 'catalog-photoreal-look' });
  let look;
  try {
    // The textures stay the user's: a draft (even "start over") keeps them.
    look = { ...parsePhotorealLookAnswer(result?.text, scene), textures: resolvePhotorealLook(place.payload)?.textures ?? {} };
  } catch (err) {
    throw refuse(`${err.message} Try again, or pick another model.`, 'PHOTOREAL_LOOK_UNREADABLE', 422);
  }
  console.log(`🎨 Photoreal look draft for place ${place.id.slice(0, 12)} via ${provider.id}: ${look.materials.length} material(s), ${look.lights.length} light(s)`);
  return { look, edited, sentPrompt, promptAdditions, providerId: provider.id, model: selectedModel || '' };
}

/**
 * Store the look under the row lock (one payload key); `null` removes it. The
 * route's schema has validated it; its zone and part names must match the saved
 * greybox at write time.
 */
export async function savePhotorealLook(ingredientId, look, { source = 'user' } = {}) {
  const updated = await catalogDB.setIngredientPayloadKey(ingredientId, 'photoreal', look, {
    source,
    guard: (current) => {
      if (current.type !== 'place') throw refuse('A photoreal look belongs to a place', 'GREYBOX_NOT_A_PLACE');
      if (!look) return;
      const [problem] = photorealLookReferenceErrors(look, resolveGreybox(current.payload));
      if (problem) throw refuse(`The look ${problem}; it may have changed on the Greybox tab.`, 'PHOTOREAL_LOOK_STALE', 409);
      if (JSON.stringify({ ...current.payload, photoreal: look }).length > CATALOG_PAYLOAD_MAX_CHARS) {
        throw refuse('This look is too large to store with the place; remove some materials or lights.', 'PHOTOREAL_LOOK_TOO_LARGE', 413);
      }
    },
  });
  if (!updated) throw refuse('Place not found', 'NOT_FOUND', 404);
  return updated;
}
