/**
 * Storyboard panel maker — runs a board's recipe nodes for one panel.
 *
 * An LLM node (prompt writer / enhancer) runs inline: its input prompt and the
 * system prompt wired into it are sent as one visible text, and the answer
 * lands on the panel as that node's editable output. An image node queues one
 * media job per frame; storyboardPanelImageHook.js turns each finished frame
 * into a panel take (selection is never changed by a new take). Runs happen
 * only on the user's tap — nothing here is called at boot or in the background.
 *
 * Run state lives on the panel (`panel.make.nodes[nodeId]`) and is written
 * through `mutateStoryboard`, so a run racing a panel edit merges against the
 * freshest record. A run id guards each LLM result and each frame's
 * bookkeeping, so a slow earlier run can't overwrite a newer one.
 */

import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveImageInputPath } from '../../lib/fileUtils.js';
import { promptAddition } from '../../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../../lib/creativeLatitude.js';
import {
  effectiveRecipe, nodeInputValue, panelNodeState, RECIPE_LIMITS, sanitizeRecipe, STORYBOARD_RENDER_SIZES, upstreamNode,
} from '../../lib/storyboardRecipe.js';
import { newStoryboardEntityId, STORYBOARD_LIMITS } from '../../lib/storyboardVocabulary.js';
import { getStoryboard, mutateStoryboard } from './index.js';

export const STORYBOARD_PANEL_RENDER_TAG = 'storyboardPanelRender';

// Overridable for tests (provider runner, queue, settings and socket are process singletons).
const deps = {
  resolveProvider: async (args) => (await import('../promptRunner.js')).resolveProviderAndModel(args),
  runPrompt: async (args) => (await import('../promptRunner.js')).runPromptThroughProvider(args),
  getSettings: async () => (await import('../settings.js')).getSettings(),
  imageParams: async (settings, route, common) => (await import('../imageGen/queueableParams.js')).queueableImageParams(
    settings, route, common, { what: 'storyboard panels', code: 'STORYBOARD_RENDER_UNAVAILABLE' },
  ),
  enqueue: async (job) => (await import('../mediaJobQueue/index.js')).enqueueJob(job),
  linkedMedia: async (ids) => (await import('../catalogDB/media.js')).listMediaForIngredients(ids),
  ingredient: async (id) => (await import('../catalogDB/ingredients.js')).getIngredient(id),
  emit: (payload) => import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('storyboard:make', payload))
    .catch((err) => console.error(`❌ storyboard:make emit failed: ${err.message}`)),
};
export const __setDepsForTests = (overrides) => Object.assign(deps, overrides);

const notFound = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
const refuse = (message, code = 'STORYBOARD_MAKE_REFUSED', status = 400) => new ServerError(message, { status, code });

function locate(board, panelId) {
  for (const beat of board.beats) {
    const panel = beat.panels.find((p) => p.id === panelId);
    if (panel) return { beat, panel };
  }
  throw notFound('Panel');
}

function recipeNode(board, nodeId) {
  const recipe = effectiveRecipe(board);
  const node = recipe.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound('Recipe node');
  return { recipe, node };
}

/** Write one node's state on a panel; `patch` may be a function of the current state. */
function patchNodeState(draft, panelId, nodeId, patch) {
  const { panel } = locate(draft, panelId);
  const current = panelNodeState(panel, nodeId);
  const next = typeof patch === 'function' ? patch(current, panel) : { ...current, ...patch };
  if (!next) return false;
  panel.make = { nodes: { ...(panel.make?.nodes || {}), [nodeId]: next } };
  return true;
}

function announce(storyboardId, panelId, nodeId, status, error = '') {
  deps.emit({ storyboardId, panelId, nodeId, status, ...(error ? { error } : {}) });
}

/**
 * The panel's linked catalog cast, environments and objects as reference
 * images: each record's newest portrait, else its newest reference image.
 * A catalog that can't be read yields none (the run still has its own refs).
 */
async function resolveLinkedRefs(panel) {
  const ids = [...panel.castIds, ...panel.environmentIds, ...panel.objectIds];
  if (!ids.length) return [];
  const media = await deps.linkedMedia(ids).catch((err) => {
    console.warn(`⚠️ Storyboard references unavailable: ${err.message}`);
    return new Map();
  });
  const firsts = ids
    .map((id) => ({ id, row: (media.get(id) || []).find((m) => (m.kind === 'portrait' || m.kind === 'reference') && /\.(png|jpe?g|webp)$/i.test(m.mediaKey || '')) }))
    .filter(({ row }) => row);
  return Promise.all(firsts.map(async ({ id, row }) => {
    const record = await deps.ingredient(id).catch(() => null);
    return { refId: id, image: row.mediaKey, label: record?.name || '' };
  }));
}

/** What the Make tab shows beside the board record: the panel's linked reference images. */
export async function getPanelMake(storyboardId, panelId) {
  const board = await getStoryboard(storyboardId);
  const { panel } = locate(board, panelId);
  return { linkedRefs: await resolveLinkedRefs(panel) };
}

/** Replace a board's recipe; null restores the default for its art style. */
export async function updateRecipe(storyboardId, recipe) {
  const { board } = await mutateStoryboard(storyboardId, (draft) => {
    draft.recipe = recipe === null ? null : sanitizeRecipe(recipe);
  });
  return board;
}

const NODE_STATE_FIELDS = ['text', 'excludedRefs', 'extraRefs'];

/** Edit a node's per-panel values: an LLM output, removed or added references. */
export async function updatePanelNode(storyboardId, panelId, nodeId, patch) {
  const fields = Object.fromEntries(NODE_STATE_FIELDS.filter((k) => Object.hasOwn(patch, k)).map((k) => [k, patch[k]]));
  const { board } = await mutateStoryboard(storyboardId, (draft) => {
    recipeNode(draft, nodeId);
    patchNodeState(draft, panelId, nodeId, fields);
  });
  return board;
}

/** Run a node for one panel. Resolves to the board with the node's new state. */
export async function runPanelNode(storyboardId, panelId, nodeId) {
  const board = await getStoryboard(storyboardId);
  const { node } = recipeNode(board, nodeId);
  if (node.type === 'llm') return runLlmNode(board, panelId, node);
  if (node.type === 'image') return runImageNode(board, panelId, node);
  throw refuse(`A ${node.title} node has nothing to run; it passes its value along.`);
}

function inputContext(board, panelId, linkedRefs = []) {
  const { beat, panel } = locate(board, panelId);
  return { beat, panel, linkedRefs };
}

async function runLlmNode(board, panelId, node) {
  const recipe = effectiveRecipe(board);
  const context = inputContext(board, panelId);
  const prompt = nodeInputValue(recipe, node.id, 'prompt', context).trim();
  if (!prompt) throw refuse(`${node.title} has no prompt: write the shot in the panel, or wire a text node into its Prompt.`);
  const system = nodeInputValue(recipe, node.id, 'system', context).trim();
  const systemNode = upstreamNode(recipe, node.id, 'system');

  const { provider, selectedModel } = await deps.resolveProvider({ providerId: node.settings.providerId || null, model: node.settings.model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one in the node settings.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');

  // The system prompt leads the one text the model reads; both blocks are
  // listed beside the user's words so Show full prompt names each.
  const sentPrompt = withCreativeLatitude(system ? `${system}\n\n---\n\n${prompt}` : prompt);
  const promptAdditions = [
    CREATIVE_LATITUDE_ADDITION,
    system ? promptAddition('system-prompt', `System prompt (${systemNode?.title || 'node'})`, system) : null,
  ].filter(Boolean);
  const runId = randomUUID();
  await mutateStoryboard(board.id, (draft) => patchNodeState(draft, panelId, node.id, {
    status: 'running', error: '', runId, sentPrompt, promptAdditions, providerId: provider.id, model: selectedModel || '',
  }));
  announce(board.id, panelId, node.id, 'running');

  let text = '';
  let error = '';
  try {
    const result = await deps.runPrompt({
      provider, model: selectedModel, effort: node.settings.effort || undefined, prompt: sentPrompt, source: 'storyboard-panel-prompt',
    });
    text = String(result?.text || '').trim();
    if (!text) error = 'The model answered with nothing.';
  } catch (err) {
    error = err?.message || 'The prompt run failed';
  }
  const { board: next } = await mutateStoryboard(board.id, (draft) => patchNodeState(draft, panelId, node.id, (current) => (
    current.runId === runId
      ? { ...current, status: error ? 'failed' : 'done', error: error.slice(0, RECIPE_LIMITS.error), ...(error ? {} : { text: text.slice(0, RECIPE_LIMITS.text) }), runAt: new Date().toISOString() }
      : null
  )));
  announce(board.id, panelId, node.id, error ? 'failed' : 'done', error);
  if (error) console.log(`🚫 Storyboard ${board.id.slice(0, 11)} ${node.title} run failed: ${error}`);
  return next;
}

async function runImageNode(board, panelId, node) {
  const recipe = effectiveRecipe(board);
  const { panel } = locate(board, panelId);
  const context = inputContext(board, panelId, await resolveLinkedRefs(panel));
  const prompt = nodeInputValue(recipe, node.id, 'prompt', context).trim();
  if (!prompt) throw refuse(`${node.title} has no prompt: run the prompt writer first, or wire a text node into its Prompt.`);
  if (prompt.length > RECIPE_LIMITS.imagePrompt) {
    throw refuse(`The prompt is ${prompt.length.toLocaleString()} characters; image models take at most ${RECIPE_LIMITS.imagePrompt.toLocaleString()}. Shorten it in the node it comes from.`, 'PROMPT_TOO_LONG');
  }
  const count = node.settings.count;
  if (panel.takes.length + count > STORYBOARD_LIMITS.takes) {
    throw refuse(`This panel keeps at most ${STORYBOARD_LIMITS.takes} takes and has ${panel.takes.length}; remove some before making ${count} more.`, 'STORYBOARD_LIMIT', 409);
  }
  const refs = nodeInputValue(recipe, node.id, 'images', context);
  const referenceImagePaths = refs.map((ref) => resolveImageInputPath(ref.image)).filter(Boolean);
  const runId = randomUUID();
  const settings = await deps.getSettings();
  const common = {
    prompt,
    ...STORYBOARD_RENDER_SIZES[board.aspectRatio],
    ...(referenceImagePaths.length ? { referenceImagePaths, referenceImageStrengths: referenceImagePaths.map(() => 1) } : {}),
    [STORYBOARD_PANEL_RENDER_TAG]: { storyboardId: board.id, panelId, nodeId: node.id, runId },
  };
  const params = await deps.imageParams(settings, { mode: node.settings.imageMode, model: node.settings.imageModelId }, common);
  // The run id lands before any job is queued, so a frame that finishes or
  // fails at once is already counted against this run.
  await mutateStoryboard(board.id, (draft) => patchNodeState(draft, panelId, node.id, {
    status: 'queued', error: '', runId, frameCount: count, jobIds: [], failedJobIds: [], takeIds: [], sentPrompt: prompt,
    sentRefs: refs, promptAdditions: [], providerId: node.settings.imageMode || '', model: node.settings.imageModelId || '',
    runAt: new Date().toISOString(),
  }));
  const jobIds = [];
  let enqueueError = null;
  for (let i = 0; i < count && !enqueueError; i += 1) {
    const queued = await deps.enqueue({ kind: 'image', params, owner: `storyboard:${board.id}` }).catch((err) => { enqueueError = err; return null; });
    if (queued?.jobId) jobIds.push(queued.jobId);
  }
  if (enqueueError) console.log(`🚫 Storyboard ${board.id.slice(0, 11)} queued ${jobIds.length} of ${count} frames: ${enqueueError.message}`);
  const { board: next } = await mutateStoryboard(board.id, (draft) => patchNodeState(draft, panelId, node.id, (current) => {
    if (current.runId !== runId) return null;
    const recorded = { ...current, jobIds, frameCount: jobIds.length, ...(enqueueError ? { error: String(enqueueError.message).slice(0, RECIPE_LIMITS.error) } : {}) };
    return { ...recorded, status: settledStatus(recorded) };
  }));
  if (!jobIds.length) {
    announce(board.id, panelId, node.id, 'failed', enqueueError?.message || 'No frame was queued');
    throw enqueueError || refuse('No frame was queued.');
  }
  announce(board.id, panelId, node.id, 'queued');
  console.log(`🖼️ Storyboard ${board.id.slice(0, 11)} panel ${panelId.slice(0, 12)} → ${jobIds.length} image job(s)`);
  return next;
}

const settledStatus = (state) => (state.takeIds.length + state.failedJobIds.length >= state.frameCount
  ? (state.takeIds.length ? 'done' : 'failed')
  : 'queued');

/** Completion: the frame becomes a panel take (selection unchanged). Null when the panel is gone. */
export async function attachPanelFrame({ storyboardId, panelId, nodeId, runId, jobId, filename }) {
  let takeId = null;
  const { board } = await mutateStoryboard(storyboardId, (draft) => {
    const { panel } = locate(draft, panelId);
    // A full panel (a manual take or another run filled it meanwhile) drops
    // the frame, counted as failed so the node still settles.
    if (panel.takes.length >= STORYBOARD_LIMITS.takes) {
      patchNodeState(draft, panelId, nodeId, (current) => countFailed(current, runId, jobId, `The panel is full (${STORYBOARD_LIMITS.takes} takes); a frame was dropped`));
      return;
    }
    takeId = newStoryboardEntityId('take');
    panel.takes.push({ id: takeId, source: 'generated', image: filename, addedAt: new Date().toISOString() });
    patchNodeState(draft, panelId, nodeId, (current) => {
      if (current.runId !== runId) return null;
      const next = { ...current, takeIds: [...current.takeIds, takeId] };
      return { ...next, status: settledStatus(next) };
    });
  }).catch((err) => {
    if (err?.code === 'NOT_FOUND') return { board: null };
    throw err;
  });
  if (!board) return null;
  announce(storyboardId, panelId, nodeId, takeId ? 'frame' : 'failed');
  return takeId ? { takeId } : null;
}

function countFailed(current, runId, jobId, reason) {
  if (current.runId !== runId || current.failedJobIds.includes(jobId)) return null;
  const next = { ...current, failedJobIds: [...current.failedJobIds, jobId], error: String(reason).slice(0, RECIPE_LIMITS.error) };
  return { ...next, status: settledStatus(next) };
}

/** A failed or canceled frame is counted, and the node settles when its last frame does. */
export async function failPanelFrame({ storyboardId, panelId, nodeId, runId, jobId }, status, error) {
  const reason = status === 'canceled' ? 'A frame was canceled' : (error || 'A frame failed');
  await mutateStoryboard(storyboardId, (draft) => patchNodeState(draft, panelId, nodeId, (current) => countFailed(current, runId, jobId, reason)))
    .catch((err) => {
      if (err?.code !== 'NOT_FOUND') throw err;
    });
  announce(storyboardId, panelId, nodeId, 'failed', reason);
}
