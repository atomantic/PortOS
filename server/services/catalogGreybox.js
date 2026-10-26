/**
 * Greybox for a Place: AI create/edit, save, and shot captures.
 *
 * `draftGreybox` runs on the user's tap only (never at boot): it sends the
 * place, the current scene (for an edit) and the user's instruction to the
 * provider › model › effort they picked and answers with a PREVIEW plus the
 * exact prompt sent. Nothing is stored until `saveGreybox`. A shot capture is an
 * ordinary reference image on the place, tagged `greybox-shot:<shotId>`, that
 * shot generation picks up like any other reference.
 */

import { ServerError } from '../lib/errorHandler.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { promptAddition } from '../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { resolveGreybox } from '../lib/greyboxScene.js';
import { GREYBOX_SHOT_ROLE_PREFIX } from '../lib/greyboxVocabulary.js';
import {
  greyboxContractInstructions,
  greyboxCurrentBlock,
  greyboxPlaceBlock,
  greyboxPrompt,
  parseGreyboxAnswer,
} from '../lib/greyboxPrompt.js';
import { CATALOG_PAYLOAD_MAX_CHARS } from '../lib/catalogValidation.js';
import * as catalogDB from './catalogDB.js';
import { uploadIngredientMediaFile } from './catalogMedia.js';

// Overridable for tests (the provider runner is a process singleton).
const deps = {
  resolveProvider: async (args) => (await import('./promptRunner.js')).resolveProviderAndModel(args),
  runPrompt: async (args) => (await import('./promptRunner.js')).runPromptThroughProvider(args),
  renderCapture: async (scene, shot) => (await import('./greyboxRender.js')).renderGreyboxPng(scene, shot),
};
export const __setGreyboxDepsForTests = (overrides) => Object.assign(deps, overrides);

const greyboxShotRole = (shotId) => `${GREYBOX_SHOT_ROLE_PREFIX}${shotId}`;

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

async function requirePlace(ingredientId) {
  const place = await catalogDB.getIngredient(ingredientId);
  if (!place) throw refuse('Place not found', 'NOT_FOUND', 404);
  if (place.type !== 'place') throw refuse('A greybox belongs to a place', 'GREYBOX_NOT_A_PLACE');
  return place;
}

// The one place the prompt is composed: the preview and the draft both call it,
// so what the user inspects before sending is exactly what is sent.
function composeGreyboxPrompt(place, { instruction, useCurrent = true }) {
  const current = useCurrent ? resolveGreybox(place.payload) : null;
  const instructions = greyboxContractInstructions();
  const placeBlock = greyboxPlaceBlock({ name: place.name, description: place.payload?.description });
  const currentBlock = greyboxCurrentBlock(current);
  const sentPrompt = withCreativeLatitude(greyboxPrompt({ instructions, placeBlock, currentBlock, request: instruction }));
  const promptAdditions = [
    CREATIVE_LATITUDE_ADDITION,
    promptAddition('greybox-contract', 'Greybox scene contract', instructions),
    promptAddition('greybox-place', 'Place', placeBlock),
    promptAddition('greybox-current', 'Current greybox', currentBlock),
  ].filter(Boolean);
  return { sentPrompt, promptAdditions, edited: Boolean(current) };
}

/** The exact prompt a draft would send, with no provider call. */
export async function previewGreyboxPrompt(ingredientId, { instruction, useCurrent = true }) {
  const { sentPrompt, promptAdditions, edited } = composeGreyboxPrompt(await requirePlace(ingredientId), { instruction, useCurrent });
  return { sentPrompt, promptAdditions, edited };
}

export async function draftGreybox(ingredientId, { instruction, providerId = '', model = '', effort = '', useCurrent = true }) {
  const place = await requirePlace(ingredientId);
  const { sentPrompt, promptAdditions, edited } = composeGreyboxPrompt(place, { instruction, useCurrent });

  const { provider, selectedModel } = await deps.resolveProvider({ providerId: providerId || null, model: model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one first.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) {
    throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');
  }

  const result = await deps.runPrompt({
    provider, model: selectedModel, effort: effort || undefined, prompt: sentPrompt, source: 'catalog-greybox',
  });
  let greybox;
  try {
    greybox = parseGreyboxAnswer(result?.text);
  } catch (err) {
    throw refuse(`${err.message} Try again, or pick another model.`, 'GREYBOX_UNREADABLE', 422);
  }
  console.log(`🧊 Greybox draft for place ${place.id.slice(0, 12)} via ${provider.id}: ${greybox.parts.length} part(s), ${greybox.shots.length} shot(s)`);
  return { greybox, edited, sentPrompt, promptAdditions, providerId: provider.id, model: selectedModel || '' };
}

/**
 * Store the place's greybox under the row lock (one payload key, never the whole
 * payload); `null` removes it. A scene must already be validated by
 * `greyboxSceneSchema` — the route's body schema does that — and the resulting
 * payload must still fit the catalog's payload cap, or ordinary profile saves
 * and federation would reject the record. Returns the updated place.
 */
export async function saveGreybox(ingredientId, scene, { source = 'user' } = {}) {
  const updated = await catalogDB.setIngredientPayloadKey(ingredientId, 'greybox', scene, {
    source,
    guard: (current) => {
      if (current.type !== 'place') throw refuse('A greybox belongs to a place', 'GREYBOX_NOT_A_PLACE');
      if (scene && JSON.stringify({ ...current.payload, greybox: scene }).length > CATALOG_PAYLOAD_MAX_CHARS) {
        throw refuse('This greybox is too large to store with the place; remove some parts.', 'GREYBOX_TOO_LARGE', 413);
      }
    },
  });
  if (!updated) throw refuse('Place not found', 'NOT_FOUND', 404);
  return updated;
}

/**
 * Attach a rendered PNG of a saved shot as the place's reference for it,
 * replacing the shot's previous capture. The shot must exist on the stored
 * greybox, so a capture can never outlive the camera that made it unnoticed.
 */
// Two overlapping captures of one shot (two open tabs) must not both read the same
// previous attachments, or each detaches only that list and both new images stay live.
const captureQueue = createKeyCachedQueue();

export const captureGreyboxShot = (ingredientId, shotId, body) =>
  captureQueue(`${ingredientId}:${shotId}`, () => replaceShotCapture(ingredientId, shotId, body));

/** An explicit render request uses the same queue and replacement transaction as a tab upload. */
export const renderGreyboxShot = (ingredientId, shotId) => maintenance.run('composition', 'Greybox shot capture',
  () => captureGreyboxShot(ingredientId, shotId, { render: true }), { continuation: true });

async function replaceShotCapture(ingredientId, shotId, { dataBase64, render = false }) {
  const place = await requirePlace(ingredientId);
  // Stored scenes were validated on save; no need to re-parse the whole thing.
  const shot = place.payload?.greybox?.shots?.find((s) => s.id === shotId);
  if (!shot) throw refuse(`Shot "${shotId}" is not saved on this place's greybox; save the shot first.`, 'GREYBOX_SHOT_UNKNOWN', 404);

  if (render) {
    const scene = resolveGreybox(place.payload);
    if (!scene || scene.source !== 'spec') throw refuse('Only saved primitive greyboxes can be rendered.', 'GREYBOX_NOT_RENDERABLE', 422);
    dataBase64 = await deps.renderCapture(scene, scene.shots.find((s) => s.id === shotId));
    const current = await requirePlace(ingredientId);
    if (JSON.stringify(resolveGreybox(current.payload)) !== JSON.stringify(scene)) {
      throw refuse('The greybox changed while rendering; re-capture the saved layout.', 'GREYBOX_CHANGED', 409);
    }
  }

  const role = greyboxShotRole(shotId);
  const previous = (await catalogDB.listMediaForIngredient(ingredientId) || [])
    .filter((m) => !m.deleted && m.role === role);
  const media = await uploadIngredientMediaFile({
    ingredientId, dataBase64, mimeType: 'image/png', role, caption: `${place.name}: ${shot.label}`,
  });
  // Detach only after the new capture is safely attached.
  for (const old of previous) {
    if (old.mediaKey !== media.mediaKey) await catalogDB.detachMedia(ingredientId, old.mediaKey, old.kind);
  }
  return media;
}
