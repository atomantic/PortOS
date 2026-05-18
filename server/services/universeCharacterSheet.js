/**
 * Universe Character — Reference Sheet Renderer.
 *
 * Generates a single dense artist reference sheet per universe canon
 * character using the shipped layout template as a low-strength init image
 * plus the character's primary portrait as a FLUX.2 multi-reference input.
 *
 * The route returns the generation id immediately; this module subscribes
 * to `imageGenEvents` to copy the result into data/image-refs/ and stamp
 * `character.referenceSheetImageRef` once the render completes.
 */

import { copyFile } from 'fs/promises';
import { join, basename } from 'path';
import { PATHS, resolveTemplateAsset, resolveGalleryImage, ensureDir } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { getSettings } from './settings.js';
import { getUniverse, updateUniverse } from './universeBuilder.js';
import { buildStyleClause } from './universeCanon.js';
import { getImageModels, isFlux2 } from '../lib/mediaModels.js';
import { enqueueJob, mediaJobEvents } from './mediaJobQueue/index.js';

const DEFAULT_TEMPLATE = 'character-reference-sheet.png';
// 2048×1536 keeps panel labels legible while staying inside FLUX.2 Klein's
// comfort envelope on Apple Silicon (≈10–15s/iter).
const DEFAULT_WIDTH = 2048;
const DEFAULT_HEIGHT = 1536;

// Resolve the model id with a FLUX.2-first preference: the reference sheet's
// init-image + multi-reference portrait anchoring only flow through FLUX.2's
// CLI flags, so a non-FLUX.2 model would silently drop the portrait. Order:
//  1. Explicit override — trust the user's deliberate choice even if it's
//     not FLUX.2 (degraded output is their call).
//  2. Settings model IF it's FLUX.2 — honors the user's persisted preference
//     when it's a valid sheet-renderer model.
//  3. First FLUX.2 model in the registry — best default for the sheet.
//  4. Settings model regardless of family — degraded output but at least the
//     user's chosen backend.
//  5. First available local model — last-resort fallback.
// Returns null when nothing is registered; caller surfaces the 400.
export function resolveSheetModelId({ override, settings, allModels }) {
  const findById = (id) => (typeof id === 'string' ? allModels.find((m) => m.id === id) : null);
  const trimmedOverride = typeof override === 'string' ? override.trim() : '';
  const overrideModel = findById(trimmedOverride);
  if (overrideModel) return overrideModel.id;
  const settingsModel = findById(settings?.imageGen?.local?.modelId);
  if (settingsModel && isFlux2(settingsModel)) return settingsModel.id;
  const firstFlux2 = allModels.find(isFlux2);
  if (firstFlux2) return firstFlux2.id;
  if (settingsModel) return settingsModel.id;
  return allModels[0]?.id || null;
}
// The template anchors panel layout, not content — keep the strength low so
// the character + style are still driven by the prompt + portrait reference.
const TEMPLATE_INIT_STRENGTH = 0.25;
const PORTRAIT_REFERENCE_STRENGTH = 0.85;

const DEFAULT_EXPRESSIONS = Object.freeze([
  'neutral', 'curious', 'worried', 'surprised', 'amused', 'determined', 'relaxed',
]);
const DEFAULT_HAND_GESTURES = Object.freeze([
  'relaxed hand', 'pointing', 'peace sign', 'gripping object', 'adjusting accessory',
]);

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

const flattenStats = (stats) => {
  if (!Array.isArray(stats) || stats.length === 0) return '';
  return stats
    .map((s) => (s?.label && s?.value ? `${s.label}: ${s.value}` : s?.label || ''))
    .filter(Boolean)
    .join(' | ');
};

const flattenPalette = (palette) => {
  if (!Array.isArray(palette) || palette.length === 0) return '';
  return palette
    .map((c, i) => {
      const name = trim(c?.name);
      const hex = trim(c?.hex);
      const role = trim(c?.role);
      if (!name) return '';
      const hexBit = hex ? ` ${hex}` : '';
      const roleBit = role ? ` — ${role}` : '';
      return `Swatch ${i + 1}: ${name}${hexBit}${roleBit}`;
    })
    .filter(Boolean)
    .join(', ');
};

const flattenWardrobes = (wardrobes) => {
  if (!Array.isArray(wardrobes) || wardrobes.length === 0) return '';
  return wardrobes
    .map((w) => (w?.name && w?.description ? `"${w.name}": ${w.description}` : w?.name || ''))
    .filter(Boolean)
    .join(' | ');
};

const flattenProps = (props) => {
  if (!Array.isArray(props) || props.length === 0) return '';
  return props
    .map((p) => {
      const name = trim(p?.name);
      const purpose = trim(p?.purpose);
      const materials = trim(p?.materials);
      if (!name) return '';
      const bits = [purpose ? `(${purpose})` : '', materials ? `[${materials}]` : '']
        .filter(Boolean)
        .join(' ');
      return bits ? `${name} ${bits}` : name;
    })
    .filter(Boolean)
    .join(' | ');
};

const flattenNamedList = (items, defaults) => {
  const list = Array.isArray(items) && items.length > 0
    ? items.map((e) => (e?.name && e?.description ? `${e.name} (${e.description})` : trim(e?.name))).filter(Boolean)
    : [...defaults];
  return list.slice(0, 7).join(', ');
};

/**
 * Build the prompt + render options for one character's reference sheet.
 * Pure function — does no I/O, doesn't enqueue anything. The route handler
 * combines this with `getUniverse` / `generateImage` to drive the actual
 * render.
 *
 * Returns `{ prompt, negativePrompt, width, height, modelId, initImagePath,
 * initImageStrength, referenceImagePaths, referenceImageStrengths }`. Paths
 * are absolute (already through resolveTemplateAsset / resolveImageRef);
 * missing paths fall through to omitted args (the runner handles that).
 */
export function buildCharacterReferenceSheetPrompt(universe, character, { template = DEFAULT_TEMPLATE } = {}) {
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
    'Honor the layout shown in the reference image: keep the same panel grid, label positions, and zone proportions. Do NOT add panels that aren\'t in the template; do NOT omit panels that are.',
  ].filter(Boolean);

  const prompt = promptParts.join('\n\n');
  const negativePrompt = 'multiple characters in the same panel, photographs, text artifacts, watermark, signature, blurry, distorted anatomy, low contrast labels';

  const initImagePath = resolveTemplateAsset(template);
  // `primaryImageRef` is a gallery filename (lives in PATHS.images, same as
  // the rest of the character's imageRefs[]). Use resolveGalleryImage —
  // resolveImageRef looks in PATHS.imageRefs and would always return null.
  const portraitRef = trim(character.primaryImageRef) ? resolveGalleryImage(character.primaryImageRef) : null;
  const referenceImagePaths = portraitRef ? [portraitRef] : [];
  const referenceImageStrengths = portraitRef ? [PORTRAIT_REFERENCE_STRENGTH] : [];

  return {
    prompt,
    negativePrompt,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    // modelId is resolved at render time from current settings — see
    // resolveSheetModelId. Returned as null here so the prompt builder stays
    // pure (no settings I/O) and the renderer is the single decision point.
    modelId: null,
    initImagePath,
    initImageStrength: initImagePath ? TEMPLATE_INIT_STRENGTH : null,
    referenceImagePaths,
    referenceImageStrengths,
  };
}

// Per-generation filename so re-renders don't trample prior versions; the
// "live" sheet pointer on the character (`referenceSheetImageRef`) always
// names the newest, but older files stay on disk for rollback.
const sheetFilename = (universeId, characterId, generationId) =>
  `universe-${String(universeId).slice(0, 8)}-${String(characterId).slice(0, 8)}-sheet-${String(generationId).slice(0, 8)}.png`;

// `(universeId, characterId) → latest generationId requested`. When a new
// render starts for a character it claims the slot; when a render completes,
// we only stamp `referenceSheetImageRef` if the slot STILL holds our
// generationId (no newer render started during ours). Prevents an
// older-but-slower render from clobbering a newer-but-finished one. The map
// grows bounded by the number of characters ever rendered.
const _latestPendingByCharacter = new Map();
const pendingKey = (universeId, characterId) => `${universeId}:${characterId}`;

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

  const built = buildCharacterReferenceSheetPrompt(universe, character, {
    template: options.template || DEFAULT_TEMPLATE,
  });
  if (!built.initImagePath) {
    throw new ServerError(
      'Character reference sheet template not found — run `npm run install:all` to provision data/templates/.',
      { status: 500, code: 'UNIVERSE_CHARACTER_SHEET_NO_TEMPLATE' },
    );
  }

  const prompt = typeof options.overridePrompt === 'string' && options.overridePrompt.trim()
    ? options.overridePrompt.trim()
    : built.prompt;
  const negativePrompt = typeof options.overrideNegativePrompt === 'string' && options.overrideNegativePrompt.trim()
    ? options.overrideNegativePrompt.trim()
    : built.negativePrompt;

  const settings = await getSettings();
  // Honor the user's current image-gen mode. The reference-sheet renderer
  // relies on init-image + multi-ref editing (FLUX.2 features) — codex /
  // external backends would silently drop those args and produce a sheet
  // without the layout anchor. Surface that as a 400 with a clear remediation
  // so the user knows to switch in Settings → Image Gen rather than getting
  // a poor render with no explanation.
  const activeMode = settings.imageGen?.mode || 'local';
  if (activeMode !== 'local') {
    throw new ServerError(
      `Character reference sheet rendering requires local image-gen mode (currently: ${activeMode}). The sheet uses the layout template as a low-strength init image and the character's primary portrait as a FLUX.2 multi-reference input — both unsupported by ${activeMode}. Switch in Settings → Image Gen.`,
      { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_REQUIRES_LOCAL' },
    );
  }
  const allModels = getImageModels();
  const modelId = resolveSheetModelId({ override: options.modelId, settings, allModels });
  if (!modelId) {
    throw new ServerError(
      'No local image-gen models are registered. Install a FLUX.2 (or other local) model via `bash scripts/setup-image-video.sh` before generating a reference sheet.',
      { status: 400, code: 'UNIVERSE_CHARACTER_SHEET_NO_MODEL' },
    );
  }
  const pythonPath = settings.imageGen?.local?.pythonPath || null;

  // Enqueue through mediaJobQueue so the render serializes through the GPU
  // lane alongside Image Gen / Universe Builder renders. Direct generateImage
  // calls would clobber imageGen/local.js's module-level activeProcess state
  // when two sheets are requested back-to-back AND wouldn't appear in
  // /api/media-jobs for reconnects. The queue assigns its own jobId — we use
  // it as the per-character "latest pending render" key.
  const queued = enqueueJob({
    kind: 'image',
    params: {
      pythonPath, modelId,
      prompt, negativePrompt,
      width: built.width,
      height: built.height,
      initImagePath: built.initImagePath,
      initImageStrength: built.initImageStrength,
      referenceImagePaths: built.referenceImagePaths,
      referenceImageStrengths: built.referenceImageStrengths,
    },
  });
  const jobId = queued.jobId;
  // Claim the latest-pending slot for this character. onSheetComplete checks
  // it before stamping — guards against an older-but-slower render finishing
  // after a newer one and overwriting the newer pointer.
  _latestPendingByCharacter.set(pendingKey(universeId, entryId), jobId);

  // Subscribe to the queue's completion bus (NOT imageGenEvents directly —
  // the queue's dispatcher mediates the imageGen lifecycle and re-emits on
  // mediaJobEvents with the full job record). Timeout guard detaches if the
  // job somehow never reaches a terminal state.
  const LISTENER_TIMEOUT_MS = 15 * 60 * 1000;
  let timeoutHandle = null;
  const detach = () => {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    mediaJobEvents.off('completed', onCompleted);
    mediaJobEvents.off('failed', onFailed);
    mediaJobEvents.off('canceled', onFailed);
  };
  const onCompleted = async (job) => {
    if (job.id !== jobId) return;
    detach();
    const sourceFilename = job.result?.filename;
    await onSheetComplete({ universeId, entryId, jobId, sourceFilename }).catch((err) => {
      console.error(`❌ Character sheet post-completion failed [${jobId.slice(0, 8)}]: ${err?.message}`);
    });
  };
  const onFailed = (job) => {
    if (job.id !== jobId) return;
    detach();
    // Release the slot so a retry render doesn't get superseded by this dead one.
    if (_latestPendingByCharacter.get(pendingKey(universeId, entryId)) === jobId) {
      _latestPendingByCharacter.delete(pendingKey(universeId, entryId));
    }
    console.log(`⚠️ Character sheet render ${job.status} [${jobId.slice(0, 8)}]: ${job.error || 'unknown'}`);
  };
  mediaJobEvents.on('completed', onCompleted);
  mediaJobEvents.on('failed', onFailed);
  mediaJobEvents.on('canceled', onFailed);
  timeoutHandle = setTimeout(() => {
    console.log(`⏱️ Character sheet render timed out waiting for queue event [${jobId.slice(0, 8)}] — detaching`);
    detach();
  }, LISTENER_TIMEOUT_MS);
  timeoutHandle.unref?.();

  // Deterministic destination filename — uses the queue's jobId so the client
  // can patch optimistically on SSE completion without a universe refetch.
  // onSheetComplete derives the same filename from the same inputs.
  const destFilename = sheetFilename(universeId, entryId, jobId);
  console.log(`🎨 Universe character sheet render — universe=${universeId.slice(0, 8)} entry=${entryId.slice(0, 8)} job=${jobId.slice(0, 8)} model=${modelId} position=${queued.position}`);
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
    console.log(`⏭️ Character sheet [${jobId.slice(0, 8)}] superseded by newer render — file saved, pointer not stamped`);
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
  // Release the slot only after a successful stamp — a failed stamp leaves
  // the slot owned by us so the next render-start cleanly overwrites it.
  _latestPendingByCharacter.delete(key);
  if (!stamped) {
    console.log(`⚠️ Character ${entryId} not found post-render — sheet saved but not linked`);
    return null;
  }
  console.log(`📌 Character ${entryId.slice(0, 8)}.referenceSheetImageRef = ${destFilename}`);
  return { filename: destFilename, path: destPath };
}

export const REFERENCE_SHEET_CONSTANTS = Object.freeze({
  DEFAULT_TEMPLATE, DEFAULT_WIDTH, DEFAULT_HEIGHT,
  TEMPLATE_INIT_STRENGTH, PORTRAIT_REFERENCE_STRENGTH,
  DEFAULT_EXPRESSIONS, DEFAULT_HAND_GESTURES,
});
