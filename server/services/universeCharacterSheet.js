/**
 * Universe Character — Reference Sheet Renderer (text-template).
 *
 * Generates a single dense artist reference sheet per universe canon
 * character from a structured TEXT prompt that describes every zone of
 * the sheet (turnaround, expressions, palette, wardrobe, props, gestures).
 * No init image or multi-reference input is required — the rich prompt
 * itself is the "template", so the renderer works equally well across
 * any image-gen backend (codex, local, future nano-banana).
 *
 * The route returns the generation id immediately; this module subscribes
 * to mediaJobEvents to copy the result into data/image-refs/ and stamp
 * `character.referenceSheetImageRef` once the render completes.
 */

import { copyFile } from 'fs/promises';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, ensureDir, shortId } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings } from './settings.js';
import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import { getImageModels } from '../lib/mediaModels.js';
import { enqueueJob, mediaJobEvents } from './mediaJobQueue/index.js';
import { findOrCreateUniverseCollection } from './mediaCollections.js';
import {
  flattenStats, flattenPalette, flattenWardrobes, flattenProps, flattenNamedList,
} from '../lib/canonPrompt.js';

// 2048×1536 keeps panel labels legible while still rendering in a single
// pass on Apple Silicon local backends. Codex / nano-banana ignore the
// hint past 1536 max edge but still honor the aspect ratio.
const DEFAULT_WIDTH = 2048;
const DEFAULT_HEIGHT = 1536;

// Resolve the local-mode model id. With pure text-template rendering we no
// longer depend on FLUX.2-specific init-image / multi-ref flags, so any
// registered model is fair game. Order:
//   1. Explicit override (when it matches a registered model).
//   2. settings.imageGen.local.modelId.
//   3. First available local model.
// Returns null when nothing is registered; caller surfaces the 400.
export function resolveSheetModelId({ override, settings, allModels }) {
  const findById = (id) => (typeof id === 'string' ? allModels.find((m) => m.id === id) : null);
  const trimmedOverride = typeof override === 'string' ? override.trim() : '';
  return findById(trimmedOverride)?.id
    ?? findById(settings?.imageGen?.local?.modelId)?.id
    ?? allModels[0]?.id
    ?? null;
}

const DEFAULT_EXPRESSIONS = Object.freeze([
  'neutral', 'curious', 'worried', 'surprised', 'amused', 'determined', 'relaxed',
]);
const DEFAULT_HAND_GESTURES = Object.freeze([
  'relaxed hand', 'pointing', 'peace sign', 'gripping object', 'adjusting accessory',
]);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

/**
 * Build the prompt + render options for one character's reference sheet.
 * Pure function — does no I/O, doesn't enqueue anything. The route handler
 * combines this with `getUniverse` / the media-job queue to drive the
 * actual render. Pure text — no init image, no multi-reference plumbing.
 *
 * Returns `{ prompt, negativePrompt, width, height, modelId }`. modelId is
 * always null here; the renderer fills it in once the active image-gen
 * mode is known.
 */
export function buildCharacterReferenceSheetPrompt(universe, character) {
  if (!universe || !character) {
    throw new ServerError('buildCharacterReferenceSheetPrompt: universe and character are required', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }

  const styleClause = buildStyleClause(universe);
  const styleBits = styleClause.startsWith('(none provided') ? '' : styleClause;

  const name = trim(character.name) || 'Unnamed';
  const aliases = Array.isArray(character.aliases) ? character.aliases.filter(Boolean).join(', ') : '';
  const role = trim(character.role);
  const pronouns = trim(character.pronouns);
  const age = trim(character.age);
  const personality = trim(character.personality);
  const speechAccent = trim(character.speechAccent);
  const coreTheme = trim(character.coreTheme);
  const visualNotes = trim(character.visualNotes);

  const headerBits = [
    `Name: ${name}.`,
    aliases ? `Alias: ${aliases}.` : '',
    age ? `Age: ${age}.` : '',
    pronouns ? `Pronouns: ${pronouns}.` : '',
    role ? `Role: ${role}.` : '',
    personality ? `Personality: ${personality}.` : '',
    speechAccent ? `Speech: ${speechAccent}.` : '',
    coreTheme ? `Core theme: ${coreTheme}.` : '',
    visualNotes ? `Visual notes: ${visualNotes}.` : '',
  ].filter(Boolean).join(' ');

  const physical = trim(character.physicalDescription);
  const silhouette = trim(character.silhouetteNotes);
  const posture = trim(character.postureNotes);
  const special = trim(character.specialTraits);
  const visualIdentity = trim(character.visualIdentity);

  const statsLine = flattenStats(character.stats);
  const paletteLine = flattenPalette(character.colorPalette);
  const wardrobeLine = flattenWardrobes(character.wardrobes);
  const propsLine = flattenProps(character.props);
  const expressionsLine = flattenNamedList(character.expressions, DEFAULT_EXPRESSIONS);
  const gesturesLine = flattenNamedList(character.handGestures, DEFAULT_HAND_GESTURES);

  // Order matters: the model honors earliest tokens most reliably, so style +
  // header lead, then the per-zone layout enumeration.
  const promptParts = [
    'CHARACTER REFERENCE SHEET — single dense reference page laid out in clear panels with thin borders, clean typography, and labeled zones.',
    styleBits || 'Style: contemporary illustrated character design with confident line work and saturated, intentional color.',
    `Character header (top of sheet): ${headerBits}`,
    physical ? `Physical description: ${physical}` : '',
    statsLine ? `Stats panel (small table, left side of header): ${statsLine}.` : '',
    `Main identity + scale sheet (large left zone): four full-body views of ${name} side by side at consistent scale — FRONT view, 3/4 view, SIDE view, BACK view — standing in a neutral pose with a small height-scale ruler in the margin. All four views must read as the same character with consistent proportions, clothing, color, and silhouette.`,
    silhouette ? `Silhouette notes panel (right of the scale sheet): ${silhouette}` : '',
    posture ? `Posture notes panel: ${posture}` : '',
    special ? `Special traits panel: ${special}` : '',
    visualIdentity ? `Visual identity panel: ${visualIdentity}` : '',
    paletteLine ? `Color palette zone (top right): a row of color swatch chips, each labeled, in order — ${paletteLine}.` : '',
    `Expression progression (right side): a row of seven head-and-shoulders portraits of ${name} showing — ${expressionsLine}.`,
    `Micro-expressions row (below expression progression): a row of five subtle headshot variants of ${name} demonstrating restrained facial nuance.`,
    `Head detail sheet (right side, lower): five small portraits of ${name} from different angles — 3/4 headshot, side headshot, top angle, low angle, three-quarter "elegant angle".`,
    `Neutral baseline + posture variation + close-up pose (lower right): one neutral standing pose, one variant posture (leaning or shifted weight), one close-up dramatic pose.`,
    wardrobeLine ? `Wardrobe / accessories details panel (lower left): labeled close-up cards of distinctive wardrobe pieces — ${wardrobeLine}.` : `Wardrobe / accessories details panel (lower left): labeled close-up cards of the character's signature garments and accessories.`,
    propsLine ? `Prop showcase panel (lower middle): a small still-life of the character's signature props — ${propsLine}.` : '',
    `Hand gestures panel (lower right): a row of five labeled hand close-ups showing the character's habitual gestures — ${gesturesLine}.`,
    'Layout: thin black panel borders on off-white paper. Light grey labels under each zone. Consistent character proportions across every view. Render in the same illustrated style throughout the page — do NOT mix art styles between panels.',
  ].filter(Boolean);

  const prompt = promptParts.join('\n\n');
  const negativePrompt = 'multiple characters in the same panel, photographs, text artifacts, watermark, signature, blurry, distorted anatomy, low contrast labels';

  return {
    prompt,
    negativePrompt,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    // modelId is resolved at render time from current settings — see
    // resolveSheetModelId. Returned as null here so the prompt builder stays
    // pure (no settings I/O) and the renderer is the single decision point.
    modelId: null,
  };
}

// Per-generation filename so re-renders don't trample prior versions; the
// "live" sheet pointer on the character (`referenceSheetImageRef`) always
// names the newest, but older files stay on disk for rollback.
const sheetFilename = (universeId, characterId, generationId) =>
  `universe-${shortId(universeId)}-${shortId(characterId)}-sheet-${shortId(generationId)}.png`;

// `(universeId, characterId) → latest generationId requested`. When a new
// render starts for a character it claims the slot; when a render completes,
// we only stamp `referenceSheetImageRef` if the slot STILL holds our
// generationId (no newer render started during ours). Prevents an
// older-but-slower render from clobbering a newer-but-finished one. The map
// grows bounded by the number of characters ever rendered.
const _latestPendingByCharacter = new Map();
const pendingKey = (universeId, characterId) => `${universeId}:${characterId}`;

// Single-dispatcher subscription so N pending sheets don't attach 4*N
// listeners on the global `mediaJobEvents` emitter (Node defaults to a
// 10-listener soft cap before warning). Each render claims an entry by
// jobId; the four module-level listeners route events to the right
// subscriber's handlers via O(1) Map lookup instead of N filters.
const sheetSubscribers = new Map(); // jobId → { onStarted, onCompleted, onFailed }
let _sheetListenersAttached = false;
function ensureSheetDispatchListeners() {
  if (_sheetListenersAttached) return;
  _sheetListenersAttached = true;
  mediaJobEvents.on('started', (job) => sheetSubscribers.get(job?.id)?.onStarted?.(job));
  mediaJobEvents.on('completed', (job) => sheetSubscribers.get(job?.id)?.onCompleted?.(job));
  const onTerminal = (job) => sheetSubscribers.get(job?.id)?.onFailed?.(job);
  mediaJobEvents.on('failed', onTerminal);
  mediaJobEvents.on('canceled', onTerminal);
}
function subscribeToSheetJob(jobId, handlers) {
  ensureSheetDispatchListeners();
  sheetSubscribers.set(jobId, handlers);
  return () => { sheetSubscribers.delete(jobId); };
}

/**
 * Returns immediately with `{ jobId, generationId, filename, path }`.
 * Deferred copy + character stamp run when imageGenEvents emits 'completed';
 * any failure there is logged (the client tracks the render via SSE).
 */
export async function renderCharacterReferenceSheet(universeId, entryId, options = {}) {
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe.characters) ? universe.characters : [];
  const character = list.find((c) => c.id === entryId);
  if (!character) {
    throw new ServerError(`Character ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  // Same frozen-identity guard the character refine/expand flows enforce —
  // the UI gates this too, but the route is reachable directly so the lock
  // has to be enforced server-side as well. 409 mirrors refineUniverseCharacter.
  if (character.locked === true) {
    throw new ServerError(
      `Character "${character.name}" is locked — unlock it before rendering a reference sheet`,
      { status: 409, code: 'UNIVERSE_CANON_LOCKED' },
    );
  }

  const built = buildCharacterReferenceSheetPrompt(universe, character);

  const prompt = typeof options.overridePrompt === 'string' && options.overridePrompt.trim()
    ? options.overridePrompt.trim()
    : built.prompt;
  const negativePrompt = typeof options.overrideNegativePrompt === 'string' && options.overrideNegativePrompt.trim()
    ? options.overrideNegativePrompt.trim()
    : built.negativePrompt;

  const settings = await getSettings();
  // Text-template rendering works with any image-gen backend. Route through
  // the media-job queue with the active mode set; codex and local are both
  // first-class. External SD-API has no multi-zone layout support, so it
  // gets a clear remediation rather than a silently-degraded render.
  const activeMode = settings.imageGen?.mode || 'local';
  const baseParams = {
    mode: activeMode,
    prompt,
    negativePrompt,
    width: built.width,
    height: built.height,
  };

  let modelId = null;
  let params;
  if (activeMode === 'codex') {
    const c = settings.imageGen?.codex || {};
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    modelId = c.model || 'codex';
    params = { ...baseParams, codexPath: c.codexPath, model: c.model };
  } else if (activeMode === 'local') {
    const allModels = getImageModels();
    modelId = resolveSheetModelId({ override: options.modelId, settings, allModels });
    if (!modelId) {
      throw new ServerError(
        'No local image-gen models are registered. Install a model via `bash scripts/setup-image-video.sh` before generating a reference sheet.',
        { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_NO_MODEL' },
      );
    }
    params = { ...baseParams, pythonPath: settings.imageGen?.local?.pythonPath || null, modelId };
  } else {
    throw new ServerError(
      `Character reference sheet rendering needs codex or local image-gen mode (currently: ${activeMode}). External SD-API doesn't support the multi-zone layout this renderer produces — switch in Settings → Image Gen.`,
      { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_UNSUPPORTED_MODE' },
    );
  }

  // Resolve (or create) the universe's media collection up front, then attach
  // a `universeRun` tag to the job so `universeBuilderCollectionHook` files
  // the rendered gallery filename (`<jobId>.png`, distinct from the
  // /data/image-refs/ copy `onSheetComplete` makes for the character pointer)
  // into the same "Universe: <name>" bucket as the rest of the universe's
  // concept art. Bookkeeping is best-effort — if provisioning fails we still
  // run the render, just without the collection-filing side-effect.
  const collection = await findOrCreateUniverseCollection({
    universeId: universe.id,
    universeName: universe.name,
    description: `Universe Builder renders for "${universe.name}"`,
  }).catch((err) => {
    console.error(`❌ character sheet → universe collection provision failed: ${err?.message || err}`);
    return null;
  });
  if (collection) {
    params.universeRun = {
      runId: randomUUID(),
      universeId: universe.id,
      collectionId: collection.id,
      category: 'character-sheet',
      label: character.name,
    };
  }

  // Enqueue through mediaJobQueue so the render serializes through the right
  // backend lane alongside Image Gen / Universe Builder renders. The queue
  // dispatches by `params.mode` (codex → codex lane, local → GPU lane).
  const queued = enqueueJob({ kind: 'image', params });
  const jobId = queued.jobId;
  // Claim the latest-pending slot for this character. onSheetComplete checks
  // it before stamping — guards against an older-but-slower render finishing
  // after a newer one and overwriting the newer pointer.
  _latestPendingByCharacter.set(pendingKey(universeId, entryId), jobId);

  // Subscribe to the queue's completion bus via the shared sheet
  // dispatcher (NOT imageGenEvents directly — the queue mediates the
  // imageGen lifecycle and re-emits on mediaJobEvents with the full job
  // record). The shared dispatcher caps listeners at 4 regardless of how
  // many sheets are pending (see `subscribeToSheetJob` above), so a user
  // running 10+ parallel character renders won't trip
  // MaxListenersExceededWarning on the global emitter.
  //
  // Two-stage timeout: a generous queue-wait window covers the pre-start
  // gap (so a sheet queued behind a long video / first-run-download
  // doesn't detach mid-queue), then the `started` event resets the timer
  // to the tighter run window. Without the reset, a sheet waiting 30+
  // minutes behind a video job would lose its bookkeeping listener
  // before onSheetComplete had a chance to run — file copy + character
  // pointer stamp lost.
  const QUEUE_WAIT_MS = 4 * 60 * 60 * 1000; // 4h — generous; survives chained video jobs.
  // 30min sits comfortably above the codex backend's 20min CODEX_TIMEOUT_MS
  // watchdog and the typical local FLUX.2 ceiling, so a legitimate slow
  // render lands its completion (or watchdog-failure) event before this
  // listener detaches. Bumping further is cheap — the detach is purely a
  // bookkeeping safety net for "queue never emits a terminal event".
  const RUN_TIMEOUT_MS = 30 * 60 * 1000;
  let timeoutHandle = null;
  let unsubscribe = null;
  const armTimeout = (ms, reason) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      console.log(`⏱️ Character sheet render ${reason} [${shortId(jobId)}] — detaching`);
      detach();
    }, ms);
    timeoutHandle.unref?.();
  };
  const detach = () => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
  unsubscribe = subscribeToSheetJob(jobId, {
    onStarted: () => armTimeout(RUN_TIMEOUT_MS, 'exceeded run window'),
    onCompleted: async (job) => {
      detach();
      const sourceFilename = job.result?.filename;
      await onSheetComplete({ universeId, entryId, jobId, sourceFilename }).catch((err) => {
        console.error(`❌ Character sheet post-completion failed [${shortId(jobId)}]: ${err?.message}`);
      });
    },
    onFailed: (job) => {
      detach();
      // Release the slot so a retry render doesn't get superseded by this dead one.
      if (_latestPendingByCharacter.get(pendingKey(universeId, entryId)) === jobId) {
        _latestPendingByCharacter.delete(pendingKey(universeId, entryId));
      }
      console.log(`⚠️ Character sheet render ${job.status} [${shortId(jobId)}]: ${job.error || 'unknown'}`);
    },
  });
  armTimeout(QUEUE_WAIT_MS, 'queue-wait timeout');

  // Deterministic destination filename — uses the queue's jobId so the client
  // can patch optimistically on SSE completion without a universe refetch.
  // onSheetComplete derives the same filename from the same inputs.
  const destFilename = sheetFilename(universeId, entryId, jobId);
  console.log(`🎨 Universe character sheet render — universe=${shortId(universeId)} entry=${shortId(entryId)} job=${shortId(jobId)} mode=${activeMode} model=${modelId} position=${queued.position}`);
  return {
    jobId,
    // `generationId` retained for client back-compat (older clients keyed
    // SSE attachment on this name); it's now an alias for `jobId`.
    generationId: jobId,
    queuePosition: queued.position,
    destFilename,
    destPath: `/data/image-refs/${destFilename}`,
    promptPreview: prompt.slice(0, 800),
  };
}

export async function onSheetComplete({ universeId, entryId, jobId, sourceFilename }) {
  if (!sourceFilename) return null;
  await ensureDir(PATHS.imageRefs);
  const destFilename = sheetFilename(universeId, entryId, jobId);
  const srcPath = join(PATHS.images, basename(sourceFilename));
  const destPath = join(PATHS.imageRefs, destFilename);
  // ALWAYS copy the file — even superseded renders are kept on disk for
  // rollback/comparison (they live at `data/image-refs/<...>-sheet-<job>.png`
  // with a unique per-job filename).
  await copyFile(srcPath, destPath);
  console.log(`📸 Character sheet copied to image-refs: ${destFilename}`);

  // If a newer render has been started for this character while ours was in
  // flight, the slot now holds someone else's jobId. Skip the stamp — the
  // newer render will stamp its own filename when it finishes. Without this,
  // an older-but-slower render could overwrite a newer-but-finished pointer.
  const key = pendingKey(universeId, entryId);
  if (_latestPendingByCharacter.get(key) !== jobId) {
    console.log(`⏭️ Character sheet [${shortId(jobId)}] superseded by newer render — file saved, pointer not stamped`);
    return { filename: destFilename, path: destPath, superseded: true };
  }
  // Stamp ONLY `referenceSheetImageRef` inside the write queue against the
  // freshest persisted universe so a concurrent user edit (or sibling render
  // landing close in time) can't clobber unrelated character fields. The
  // sheet lives in data/image-refs/, distinct from `imageRefs[]` (gallery,
  // /data/images/) — polluting imageRefs would 404 the CanonCard thumbnail.
  let stamped = false;
  await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest.characters) ? latest.characters : [];
    const latestIdx = latestList.findIndex((c) => c.id === entryId);
    if (latestIdx < 0) return null;
    const nextList = latestList.map((e, i) => (i === latestIdx ? {
      ...e,
      referenceSheetImageRef: destFilename,
    } : e));
    stamped = true;
    return { characters: nextList };
  });
  // Release the slot only after a successful stamp AND only if it still
  // belongs to us — between the supersede check and this delete, a newer
  // render could have started, claimed the slot, and arrived here in
  // parallel. An unconditional delete would wipe the newer render's slot
  // and cause its onSheetComplete to see "superseded" (slot empty ≠ jobId)
  // and skip its own stamp — leaving the older filename persisted. A
  // failed stamp leaves the slot owned by us so the next render-start
  // cleanly overwrites it.
  if (_latestPendingByCharacter.get(key) === jobId) {
    _latestPendingByCharacter.delete(key);
  }
  if (!stamped) {
    console.log(`⚠️ Character ${entryId} not found post-render — sheet saved but not linked`);
    return null;
  }
  console.log(`📌 Character ${shortId(entryId)}.referenceSheetImageRef = ${destFilename}`);
  return { filename: destFilename, path: destPath };
}

export const REFERENCE_SHEET_CONSTANTS = Object.freeze({
  DEFAULT_WIDTH, DEFAULT_HEIGHT,
  DEFAULT_EXPRESSIONS, DEFAULT_HAND_GESTURES,
});
