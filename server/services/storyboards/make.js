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
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { copyFileGuarded, ensureDir, PATHS, resolveImageInputPath } from '../../lib/fileUtils.js';
import { maxInputImages } from '../../lib/imageGenCapabilities.js';
import { promptAddition } from '../../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../../lib/creativeLatitude.js';
import {
  effectiveRecipe, imageNodePrompt, nodeInputValue, panelNodeState, RECIPE_LIMITS, recipeRunOrder, sanitizeRecipe, STORYBOARD_RENDER_SIZES,
  upstreamNode,
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
  markupPath: async (key) => (await import('../mediaSketches.js')).getSketchPngPath(key),
  linkedMedia: async (ids) => (await import('../catalogDB/media.js')).listMediaForIngredients(ids),
  ingredient: async (id) => (await import('../catalogDB/ingredients.js')).getIngredient(id),
  resolveImage: (image) => resolveImageInputPath(image),
  emit: (payload) => import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('storyboard:make', payload))
    .catch((err) => console.error(`❌ storyboard:make emit failed: ${err.message}`)),
  emitBatch: (payload) => import('../socket.js')
    .then(({ getIo }) => getIo()?.emit('storyboard:make-batch', payload))
    .catch((err) => console.error(`❌ storyboard:make-batch emit failed: ${err.message}`)),
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

const LINKED_IMAGE = /\.(png|jpe?g|webp)$/i;
const isLinkedImage = (row) => !!row
  && (row.kind === 'portrait' || row.kind === 'reference')
  && LINKED_IMAGE.test(row.mediaKey || '');

/**
 * The panel's linked catalog cast, environments and objects as reference
 * images. A `linkMedia` pick names one gallery image of that record; anything
 * else (no pick, a missing file, a non-image) keeps the newest portrait, else
 * the newest reference. A catalog that can't be read yields none (the run
 * still has its own refs).
 */
async function resolveLinkedRefs(panel) {
  // Places and objects lead: a backend cap keeps the first refs, and the set is
  // the one reference no other link can stand in for (#14381).
  const ids = [...panel.environmentIds, ...panel.objectIds, ...panel.castIds];
  if (!ids.length) return [];
  const media = await deps.linkedMedia(ids).catch((err) => {
    console.warn(`⚠️ Storyboard references unavailable: ${err.message}`);
    return new Map();
  });
  const picks = panel.linkMedia && typeof panel.linkMedia === 'object' && !Array.isArray(panel.linkMedia) ? panel.linkMedia : {};
  const firsts = ids.map((id) => {
    const rows = media.get(id) || [];
    const wanted = typeof picks[id] === 'string' ? picks[id] : '';
    const row = (wanted && rows.find((item) => item.mediaKey === wanted && isLinkedImage(item))) || rows.find(isLinkedImage);
    return row ? { id, row } : null;
  }).filter(Boolean);
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

// A correction asks the writer to redo its own prompt with the director's
// note; the note is quoted as written and the whole block is a listed addition.
function correctionText({ current, note }) {
  return [
    ...(current ? ['The current frame was drawn from this prompt:', current, ''] : []),
    `The director marked up the current frame and asks for this change: "${note}"`,
    'Rewrite the prompt with that change. Keep everything the note does not mention, and say plainly where things now sit in the frame.',
  ].join('\n');
}

async function runLlmNode(board, panelId, node, { correction = null } = {}) {
  const recipe = effectiveRecipe(board);
  const context = inputContext(board, panelId);
  const prompt = nodeInputValue(recipe, node.id, 'prompt', context).trim();
  if (!prompt) throw refuse(`${node.title} has no prompt: write the shot in the panel, or wire a text node into its Prompt.`);
  const system = nodeInputValue(recipe, node.id, 'system', context).trim();
  const systemNode = upstreamNode(recipe, node.id, 'system');
  const correcting = correction ? correctionText(correction) : '';

  const { provider, selectedModel } = await deps.resolveProvider({ providerId: node.settings.providerId || null, model: node.settings.model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one in the node settings.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');

  // The system prompt leads the one text the model reads; both blocks are
  // listed beside the user's words so Show full prompt names each.
  const userText = correcting ? `${prompt}\n\n${correcting}` : prompt;
  const sentPrompt = withCreativeLatitude(system ? `${system}\n\n---\n\n${userText}` : userText);
  const promptAdditions = [
    CREATIVE_LATITUDE_ADDITION,
    system ? promptAddition('system-prompt', `System prompt (${systemNode?.title || 'node'})`, system) : null,
    correcting ? promptAddition('correction', 'Correction', correcting) : null,
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

/**
 * Queue an image node's frames. The model reads the shot (its Prompt input)
 * as written, then a correction note when there is one, then the style (its
 * Style input); each block PortOS adds is listed with the sent prompt.
 */
async function runImageNode(board, panelId, node, { frameRef = null, count: frames = null, selectOnLand = false, note = '' } = {}) {
  const recipe = effectiveRecipe(board);
  const { panel } = locate(board, panelId);
  const context = inputContext(board, panelId, await resolveLinkedRefs(panel));
  const { shot, prompt, additions: promptAdditions } = imageNodePrompt(recipe, node.id, context, { note });
  if (!shot) throw refuse(`${node.title} has no prompt: write the shot in the panel, or wire a text node into its Prompt.`);
  if (prompt.length > RECIPE_LIMITS.imagePrompt) {
    throw refuse(`The prompt is ${prompt.length.toLocaleString()} characters; image models take at most ${RECIPE_LIMITS.imagePrompt.toLocaleString()}. Shorten it in the node it comes from.`, 'PROMPT_TOO_LONG');
  }
  const count = frames || node.settings.count;
  if (panel.takes.length + count > STORYBOARD_LIMITS.takes) {
    throw refuse(`This panel keeps at most ${STORYBOARD_LIMITS.takes} takes and has ${panel.takes.length}; remove some before making ${count} more.`, 'STORYBOARD_LIMIT', 409);
  }
  const wired = nodeInputValue(recipe, node.id, 'images', context);
  const pathOf = (ref) => (ref === frameRef && frameRef.path) || deps.resolveImage(ref.image);
  // A ref whose file no longer resolves is never sent, so it takes no capped slot and is not recorded as sent.
  const usable = (frameRef ? [frameRef, ...wired.filter((ref) => ref.image !== frameRef.image)] : wired).filter((ref) => pathOf(ref));
  const refs = frameRef ? usable.slice(0, RECIPE_LIMITS.images) : usable;
  const runId = randomUUID();
  const settings = await deps.getSettings();
  const common = {
    prompt,
    ...STORYBOARD_RENDER_SIZES[board.aspectRatio],
    ...referencePayload(refs, pathOf),
    [STORYBOARD_PANEL_RENDER_TAG]: { storyboardId: board.id, panelId, nodeId: node.id, runId },
  };
  const resolvedParams = await deps.imageParams(settings, { mode: node.settings.imageMode, model: node.settings.imageModelId }, common);
  // Keep the leading refs the resolved backend accepts, so the run records what
  // was sent rather than relying on the queue's silent backstop trim (#14381).
  const cap = maxInputImages(resolvedParams.mode, resolvedParams.modelId ?? resolvedParams.model ?? null);
  const sentRefs = cap != null && refs.length > cap ? refs.slice(0, cap) : refs;
  const { referenceImagePaths: _paths, referenceImageStrengths: _strengths, ...unreferenced } = resolvedParams;
  const params = sentRefs === refs ? resolvedParams : { ...unreferenced, ...referencePayload(sentRefs, pathOf) };
  // The run id lands before any job is queued, so a frame that finishes or
  // fails at once is already counted against this run.
  await mutateStoryboard(board.id, (draft) => patchNodeState(draft, panelId, node.id, {
    status: 'queued', error: '', runId, frameCount: count, jobIds: [], failedJobIds: [], takeIds: [], sentPrompt: prompt,
    sentRefs, promptAdditions, providerId: node.settings.imageMode || '', model: node.settings.imageModelId || '',
    selectOnLand, runAt: new Date().toISOString(),
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

function referencePayload(refs, pathOf) {
  const referenceImagePaths = refs.map(pathOf).filter(Boolean);
  return referenceImagePaths.length ? { referenceImagePaths, referenceImageStrengths: referenceImagePaths.map(() => 1) } : {};
}

/**
 * The frame a correction starts from: the take's saved markup (the image with
 * the strokes drawn on it), else the take as it is. The markup is copied into
 * the image-refs root as a staged `ref-<uuid>` input, so a later re-draw can't
 * change what this run sent and the refs GC keeps it while a render names it.
 */
async function correctionFrame(image) {
  const markup = await deps.markupPath(`image:${image}`);
  if (!markup) return { image, label: 'Current frame' };
  await ensureDir(PATHS.imageRefs);
  const staged = `ref-${randomUUID()}.png`;
  const path = join(PATHS.imageRefs, staged);
  await copyFileGuarded(markup, path);
  return { image: staged, label: 'Marked-up frame', path };
}

/**
 * Correct a panel's frame: the Image node makes new frames with the
 * marked-up frame as the first reference and the note after the shot; with a
 * prompt writer wired in, the writer rewrites its prompt with the note instead. New frames land as takes; the
 * selection is unchanged. Resolves to the board once the frames are queued; a
 * writer failure is refused (its node card keeps the reason).
 */
export async function correctPanel(storyboardId, panelId, { takeId, note }) {
  const board = await getStoryboard(storyboardId);
  const recipe = effectiveRecipe(board);
  const { panel } = locate(board, panelId);
  const take = panel.takes.find((t) => t.id === takeId);
  if (!take) throw notFound('Take');
  if (!take.image) throw refuse('Only a frame image can be corrected; this take is a sketch you can draw on directly.');
  const imageNode = recipeRunOrder(recipe).find((n) => n.type === 'image');
  if (!imageNode) throw refuse('The recipe has no Image node, so there is nothing to redraw.');
  const writer = upstreamNode(recipe, imageNode.id, 'prompt');
  const frameRef = await correctionFrame(take.image);
  if (writer?.type !== 'llm') {
    const next = await runImageNode(board, panelId, imageNode, { frameRef, note });
    console.log(`✏️ Storyboard ${storyboardId.slice(0, 11)} panel ${panelId.slice(0, 12)} corrected from ${frameRef.label.toLowerCase()}`);
    return next;
  }
  const current = panelNodeState(panel, writer.id).text.trim();
  const written = await runLlmNode(board, panelId, writer, { correction: { current, note } });
  const writerState = panelNodeState(locate(written, panelId).panel, writer.id);
  if (writerState.status === 'failed') throw refuse(`${writer.title} could not rewrite the prompt: ${writerState.error}`, 'STORYBOARD_CORRECTION_FAILED', 502);
  const next = await runImageNode(written, panelId, imageNode, { frameRef });
  console.log(`✏️ Storyboard ${storyboardId.slice(0, 11)} panel ${panelId.slice(0, 12)} corrected from ${frameRef.label.toLowerCase()}`);
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
      // A redraw-all run asked for its first frame to become the panel's art.
      if (current.selectOnLand && !current.takeIds.length) panel.selectedTakeId = takeId;
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

// Make empty panels: one batch per board at a time, in memory only (a restart
// ends it; nothing resumes on its own at boot).
const batches = new Map();
const RUNNABLE_TYPES = new Set(['llm', 'image']);
const IN_FLIGHT = new Set(['running', 'queued']);

const runnableSteps = (board) => recipeRunOrder(effectiveRecipe(board)).filter((node) => RUNNABLE_TYPES.has(node.type));
const isPanelDrawing = (panel, steps) => steps.some((node) => IN_FLIGHT.has(panelNodeState(panel, node.id).status));
// A panel with no art and no frames on the way.
const isEmptyPanel = (panel, steps) => !panel.takes.length && !isPanelDrawing(panel, steps);
const emptyPanelIds = (board, steps) => board.beats.flatMap((beat) => beat.panels).filter((panel) => isEmptyPanel(panel, steps)).map((p) => p.id);
const batchView = (storyboardId, batch) => (batch ? { storyboardId, ...batch } : null);

async function stepLabel(node) {
  if (node.type === 'image') {
    return { nodeId: node.id, title: node.title, type: node.type, model: node.settings.imageModelId || 'Default image model', frames: node.settings.count };
  }
  const { provider, selectedModel } = await deps.resolveProvider({ providerId: node.settings.providerId || null, model: node.settings.model || null })
    .catch(() => ({ provider: null }));
  const model = provider ? [provider.name || provider.id, selectedModel].filter(Boolean).join(' · ') : 'No AI provider set up';
  return { nodeId: node.id, title: node.title, type: node.type, model, frames: 0 };
}

// Every panel with no frames on the way (Redraw all).
const idlePanelIds = (board, steps) => board.beats.flatMap((beat) => beat.panels)
  .filter((panel) => !isPanelDrawing(panel, steps)).map((p) => p.id);

/**
 * What "Make empty panels" or "Redraw all" would do, for the confirm that
 * names it: how many panels each would run on, and each node it runs with the
 * model it uses.
 */
export async function getMakeEmptyPlan(storyboardId) {
  const board = await getStoryboard(storyboardId);
  const steps = runnableSteps(board);
  return {
    batch: batchView(storyboardId, batches.get(storyboardId)),
    panelCount: emptyPanelIds(board, steps).length,
    allCount: idlePanelIds(board, steps).length,
    steps: await Promise.all(steps.map(stepLabel)),
  };
}

/**
 * Run the recipe on every panel with no art, one panel after another. A
 * prompt already written for a panel is kept (it may be the user's edit); an
 * LLM failure skips that panel's image so no frame is made from no prompt.
 * `redraw` runs it on every panel instead (a new art style): each prompt is
 * rewritten, one frame is drawn, and with `selectNew` it becomes the panel's
 * art; earlier takes stay. Answers at once; `storyboard:make-batch` reports
 * progress.
 */
export async function startMakeEmpty(storyboardId, { redraw = false, selectNew = false } = {}) {
  if (batches.has(storyboardId)) throw refuse('This board is already making its empty panels.', 'STORYBOARD_BATCH_RUNNING', 409);
  const board = await getStoryboard(storyboardId);
  const steps = runnableSteps(board);
  if (!steps.some((node) => node.type === 'image')) throw refuse('The recipe has no Image node, so there is nothing to make.');
  const panelIds = redraw ? idlePanelIds(board, steps) : emptyPanelIds(board, steps);
  if (!panelIds.length) throw refuse(redraw ? 'Every panel is already drawing.' : 'Every panel already has art.');
  // Re-checked after the read: two quick taps (or two tabs) both passed the first check.
  if (batches.has(storyboardId)) throw refuse('This board is already making its empty panels.', 'STORYBOARD_BATCH_RUNNING', 409);
  const batch = { status: 'running', redraw, total: panelIds.length, done: 0, failed: 0, startedAt: new Date().toISOString() };
  batches.set(storyboardId, batch);
  deps.emitBatch(batchView(storyboardId, batch));
  console.log(`🎬 Storyboard ${storyboardId.slice(0, 11)} ${redraw ? 'redrawing' : 'making'} ${panelIds.length} panel(s)`);
  runBatch(storyboardId, panelIds, batch, { redraw, selectNew })
    .catch((err) => console.error(`❌ Storyboard ${storyboardId.slice(0, 11)} empty-panel batch stopped: ${err.message}`))
    .finally(() => {
      batches.delete(storyboardId);
      deps.emitBatch(batchView(storyboardId, { ...batch, status: 'done' }));
    });
  return { batch: batchView(storyboardId, batch) };
}

async function runBatch(storyboardId, panelIds, batch, options) {
  for (const panelId of panelIds) {
    const ok = await makePanel(storyboardId, panelId, options);
    batch.done += 1;
    if (!ok) batch.failed += 1;
    deps.emitBatch(batchView(storyboardId, batch));
  }
}

/**
 * Run the recipe's steps on one panel, in order. Redrawing reruns every
 * writer and draws one frame (selected on landing with `selectNew`);
 * otherwise a prompt already written is kept and the image node makes its
 * usual count. Resolves to the board; a failed step throws its reason.
 */
async function runPanelSteps(storyboardId, panelId, steps, { redraw = false, selectNew = false } = {}) {
  let next = await getStoryboard(storyboardId);
  for (const node of steps) {
    if (!redraw && node.type === 'llm' && panelNodeState(locate(next, panelId).panel, node.id).text.trim()) continue;
    next = redraw && node.type === 'image'
      ? await runImageNode(await getStoryboard(storyboardId), panelId, node, { count: 1, selectOnLand: selectNew })
      : await runPanelNode(storyboardId, panelId, node.id);
    const state = panelNodeState(locate(next, panelId).panel, node.id);
    if (state.status === 'failed') throw refuse(`${node.title} failed: ${state.error || 'no reason given'}`, 'STORYBOARD_DRAW_FAILED', 502);
  }
  return next;
}

/** One panel's run; false when it was skipped or a node failed. A deleted board ends the batch. */
async function makePanel(storyboardId, panelId, options = {}) {
  const board = await getStoryboard(storyboardId);
  const steps = runnableSteps(board);
  const panel = board.beats.flatMap((beat) => beat.panels).find((p) => p.id === panelId);
  // Removed, or given art (or, redrawing, a run) since the batch started.
  if (!panel || (options.redraw ? isPanelDrawing(panel, steps) : !isEmptyPanel(panel, steps))) return false;
  try {
    await runPanelSteps(storyboardId, panelId, steps, options);
    return true;
  } catch (err) {
    if (err?.code === 'NOT_FOUND' && err.message.startsWith('Storyboard')) throw err;
    console.log(`🚫 Storyboard ${storyboardId.slice(0, 11)} panel ${panelId.slice(0, 12)} skipped: ${err.message}`);
    return false;
  }
}

/**
 * Draw one panel: the recipe runs on the panel's shot (an optional prompt
 * enhancer rewrites it first), and the image node draws one frame, which
 * becomes the panel's selected art (earlier takes stay). Resolves once the frame is
 * queued; `storyboard:make` follows it.
 */
export async function drawPanel(storyboardId, panelId) {
  const board = await getStoryboard(storyboardId);
  const steps = runnableSteps(board);
  if (!steps.some((node) => node.type === 'image')) throw refuse('The recipe has no Image node, so there is nothing to draw.');
  if (isPanelDrawing(locate(board, panelId).panel, steps)) throw refuse('This panel is already drawing.', 'STORYBOARD_PANEL_BUSY', 409);
  const next = await runPanelSteps(storyboardId, panelId, steps, { redraw: true, selectNew: true });
  console.log(`✏️ Storyboard ${storyboardId.slice(0, 11)} panel ${panelId.slice(0, 12)} drawing`);
  return next;
}
