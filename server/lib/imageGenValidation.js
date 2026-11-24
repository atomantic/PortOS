/**
 * Zod schemas and multipart form coercion for image generation routes (`routes/imageGen.js`)
 * and shot-card frame submission (`services/musicVideo/sceneCardRender.js`).
 */

import { z } from 'zod';
import { IMAGE_GEN_MODES } from './generationModes.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT, REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX } from './imageGenCapabilities.js';
import { musicVideoCastInputsSchema } from './musicVideo/musicVideoValidation.js';
import { universeVisualProfileSchema } from './universeVisualProfileValidation.js';
import { filmLookBakeSchema } from './filmLookValidation.js';
import { EFFORT_LEVELS } from './provider/providerModels.js';
import { promptAdditionsSchema } from './modelInput.js';
import { imageEdgeSchema, refineImagePixelCap, PIXEL_CAP_MESSAGE } from './sharedSchemas.js';

export { filmLookBakeSchema };

// Shared validation limits. MAX_REFERENCE_IMAGES must stay in sync with the
// number of `referenceImageN` upload field names below.
const MAX_PROMPT_LENGTH = 32000;
const MAX_LORAS = 8;
export const MAX_REFERENCE_IMAGES = IMAGE_REFERENCE_REQUEST_LIMIT;
export const REFERENCE_IMAGE_FIELDS = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => `referenceImage${i + 1}`);

export const updatePromptSchema = z.object({ prompt: z.string().max(MAX_PROMPT_LENGTH) });
const galleryImageFilenameSchema = (label) => z.string().max(256)
  .regex(/^[^/\\]+\.(png|jpg|jpeg|webp)$/i, `${label} must be a basename ending in png/jpg/jpeg/webp`);

// Rejected, never stripped: model input is not silently modified. spawn() also throws on NUL.
const noNulPrompt = z.string().max(MAX_PROMPT_LENGTH)
  .refine((v) => !v.includes('\0'), { message: 'Prompt may not contain a NUL character' });

export const generateSchema = z.object({
  promptAdditions: promptAdditionsSchema,
  quickEdit: z.boolean().optional(),
  verifyImage: z.boolean().optional(),
  reviewedPromptDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Empty prompt allowed — i2i / edit / unconditional generation don't require
  // one. The multipart FormData builder drops empty-string fields, so an empty
  // prompt arrives as `undefined`; default it to '' rather than rejecting.
  prompt: noNulPrompt.optional().default(''),
  negativePrompt: noNulPrompt.optional(),
  // A multipart form sends the profile as one JSON string field.
  visualProfileOverride: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }, universeVisualProfileSchema.nullable().optional()),
  // Per-request backend override. If omitted, the dispatcher uses
  // `imageGen.mode` from settings.json.
  mode: z.enum(IMAGE_GEN_MODES).optional(),
  modelId: z.string().max(64).optional(),
  // Per-render Codex reasoning effort. Other image backends ignore this
  // provider-specific preference, preserving the story pin across a backend
  // switch without inventing a second image request shape.
  effort: z.enum(EFFORT_LEVELS).optional(),
  // Per-render override of a cloud CLI's session model, replacing the saved
  // `settings.imageGen.<mode>.model` for this one queue item. Deliberately NOT
  // `modelId`: that field carries a *local* model id (`dev`, `schnell`), and a
  // form that keeps it populated while the user flips to a cloud backend would
  // otherwise hand the CLI an id it rejects. Ignored by providers whose spec
  // has no model knob (grok). Same charset as the provider-side MODEL_ID_RE so
  // a typo'd id fails validation here rather than at spawn time.
  cloudModel: z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'invalid cloud model id').optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // mflux supports 3/4/5/6/8 bit quantization; 8 is the default.
  quantize: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(8), z.literal('3'), z.literal('4'), z.literal('5'), z.literal('6'), z.literal('8')]).optional(),
  // Filenames only (basenames) — server resolves against PATHS.loras and
  // applies the prefix-check. Old payloads sent absolute server paths
  // (`loraPaths`); accept both for back-compat with stored gallery sidecars.
  loraFilenames: z.array(z.string().max(256).regex(/^[^/\\]+$/, 'lora filename must not contain path separators')).max(MAX_LORAS).optional(),
  loraPaths: z.array(z.string().max(512)).max(MAX_LORAS).optional(),
  loraScales: z.array(z.number().min(0).max(2)).max(MAX_LORAS).optional(),
  // i2i: pick an existing gallery image (basename) as the init image. If
  // initImage was uploaded via multipart, this is ignored in favor of the
  // upload. Strength: 0.0 = ignore source, 1.0 = max influence.
  initImageFile: galleryImageFilenameSchema('init image').optional(),
  initImageStrength: z.number().min(0).max(1).optional(),
  // Multi-reference image conditioning. Up to 4 reference images are uploaded
  // as separate multipart fields `referenceImage1` … `referenceImage4`, or
  // named from the existing gallery through JSON `referenceImageFiles`;
  // `referenceStrengths` is a parallel array of weights (0.0 = ignore the
  // reference, 1.0 = full influence), ordered as named files then uploads.
  // Uploaded file presence is enforced at the upload layer, and the route
  // pairs all surviving slots with their strengths positionally. Strengths are honored
  // numerically only by local FLUX.2; the cloud CLIs expose no per-reference
  // weight, so they receive the paths alone.
  referenceImageFiles: z.array(galleryImageFilenameSchema('reference image')).max(MAX_REFERENCE_IMAGES).optional(),
  reviewedReferenceDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  referenceStrengths: z.array(z.number().min(0).max(1)).max(MAX_REFERENCE_IMAGES).optional(),
  // Per-render override of the cleaners. When omitted, the route inherits
  // from `settings.imageGen.{mode}.{cleanC2PA,denoise}`. Explicit booleans
  // here force the value for this one render. Legacy `autoClean` is still
  // accepted (mapped to both flags) so older clients keep working through
  // the deprecation window.
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  autoClean: z.boolean().optional(),
  // Optional universe-collection target. When present, the route resolves the
  // universe's media collection server-side and tags the queued job so
  // `universeBuilderCollectionHook` files the finished render into that
  // collection — the same auto-filing path batch renders and character
  // reference sheets use. The client passes only the universe identity (never
  // a collectionId — that's server-resolved), so the front-end does no
  // collection bookkeeping. The base-style probe (StyleProbeImage) and the
  // Universe canon section-local renders (#1395) are the callers; JSON-only
  // (the multipart ImageGen page never sends it).
  universeRun: z.object({
    universeId: z.string().min(1).max(200),
    universeName: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    category: z.string().max(64).optional(),
    // Section-local canon renders (#1395) tag the target entry so the
    // completion hook durably appends the render to its `imageRefs[]` even
    // after the originating page unmounts — converging these renders onto the
    // same durable path batch renders use. Shape mirrors the batch path's
    // entryRef (server/services/universeBuilder.js `ENTRY_REF_KIND`).
    entryRef: z.object({
      kind: z.enum(['canon', 'variation', 'sheet']),
      kindKey: z.string().min(1).max(64).optional(),
      categoryKey: z.string().min(1).max(64).optional(),
      id: z.string().min(1).max(200),
    }).refine(
      // Each kind needs its locating key, else appendEntryImageRef silently
      // no-ops: canon→kindKey, variation→categoryKey (sheet needs neither).
      (r) => (r.kind === 'canon' ? !!r.kindKey : r.kind === 'variation' ? !!r.categoryKey : true),
      { message: 'entryRef requires its locating key (canon→kindKey, variation→categoryKey)' },
    ).optional(),
  }).optional(),
  // Writers-Room storyboard scene render (#1363). When present, the mediaJobQueue
  // completion hook (`writersRoomSceneImageHook`) files the finished render onto
  // the analysis snapshot's `sceneImages[sceneId]` AND mirrors it into the work's
  // auto-collection — durably, even if the editor unmounted mid-render (the
  // "navigated away → image never attached" failure mode the synchronous attach
  // suffered). Only the async local/Codex lanes ride the queue this hook listens
  // to; the synchronous external SD-API lane still attaches via the scene-image
  // route. The scene prompt is read from the job's own `prompt` param, so the tag
  // carries only the destination identity. JSON-only (the multipart ImageGen page
  // never sends it).
  writersRoom: z.object({
    workId: z.string().min(1).max(200),
    analysisId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
  }).optional(),
  // FableLoom scene render. When present, the mediaJobQueue completion hook
  // (`fableLoomSceneImageHook`) files the finished render onto that loom
  // episode's scene node — durably, even if the editor unmounted mid-render.
  // Only the async local/Codex lanes ride the queue; the synchronous external
  // SD-API lane is attached directly by this route after generation. Rides
  // into job.params untouched via `...params`. JSON-only.
  fableLoom: z.object({
    loomId: z.string().min(1).max(200),
    episodeId: z.string().min(1).max(200),
    nodeId: z.string().min(1).max(200),
    role: z.literal('image').optional(),
  }).optional(),
  // Music Video scene reference-frame render (#1760 Phase 1b). When present, the
  // mediaJobQueue completion hook (`musicVideoSceneImageHook`) appends the
  // finished render to the project scene's takes (#8965) — durably, even if the
  // director board unmounted mid-render. Only the async local/Codex lanes ride
  // the queue this hook listens to; the synchronous external SD-API lane returns
  // the filename inline and the client adds it through the scene takes route. Rides
  // into job.params untouched via `...params` (like `writersRoom`). JSON-only.
  musicVideo: z.object({
    projectId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
    catalogBasis: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    // Selective section revision (#9011): see the matching comment on the
    // video route's musicVideo schema (server/lib/videoGenValidation.js).
    revisionId: z.string().min(1).max(200).optional(),
    // #11173: 'end' files the render as the scene's style-break end frame
    // (an `endImage` take) instead of its start frame.
    slot: z.enum(['end']).optional(),
    // #11317: the prompt is the director's text; the server composes the still's
    // prompt and lists each block it adds. `fromFrame` reworks the first reference
    // image (a picked frame); `refine` makes the prompt an edit instruction for it.
    compose: z.boolean().optional(),
    fromFrame: z.boolean().optional(),
    refine: z.boolean().optional(),
    includeReferences: z.boolean().optional(),
    greyboxImageId: galleryImageFilenameSchema('greybox capture').optional(),
    greyboxBlockingImageId: galleryImageFilenameSchema('greybox blocking capture').optional(),
    // The frame a from-frame or refine reworks, when the caller did not put it
    // first in referenceImageFiles. The card's frame route sends both.
    leadImageId: galleryImageFilenameSchema('lead frame').optional(),
    // The guides and sheets this submit actually sent (#14154). The completion
    // hook copies them onto the take; it does not look them up again.
    castInputs: musicVideoCastInputsSchema.optional(),
    replaceSelection: z.boolean().optional(),
    expectedSelection: galleryImageFilenameSchema('selected frame').nullable().optional(),
    // Clip from storyboard: once this still lands as the shot's selection, the
    // completion hook animates it on this lane (a model the card picked wins).
    thenClip: z.object({
      backend: z.string().min(1).max(40).optional(),
      model: z.string().min(1).max(300).optional(),
      songAudio: z.boolean().optional(),
    }).optional(),
  }).optional(),
  // File the render into this music video's media collection even when no shot
  // keeps it (sheets, tests, alternates): musicVideoCollectionHook for the
  // queued lanes, inline below for the synchronous one. Collection only; the
  // render itself is unchanged.
  musicVideoProjectId: z.string().min(1).max(200).optional(),
  // File the finished render into the collection with this name, creating it
  // when absent (requestedCollectionHook; inline for the synchronous image lane).
  collectionName: z.string().trim().min(1).max(80).optional(),
  // Durable catalog attach (#1359). When present, the mediaJobQueue completion
  // hook (catalogImageAttachHook) files the finished render onto this catalog
  // ingredient even if the page that started the render has since unmounted —
  // so a long queued local/Codex render is no longer lost to navigation.
  // `catalogMediaKind` forces portrait/reference; omitted = auto (first image →
  // portrait, later → reference, mirroring the client's optimistic path). Only
  // the async (local/codex) lanes need this — the synchronous external SD-API
  // path returns the filename to the client, which attaches it directly.
  catalogIngredientId: z.string().min(1).max(200).optional(),
  catalogMediaKind: z.enum(['portrait', 'reference']).optional(),
  // Federated media provider (#4348). When set, the render is submitted to
  // THIS registered peer instead of running on local hardware. Server-validated
  // against the per-peer allowlist — an agent cannot route work to an arbitrary
  // peer by naming one here. mediaProviderEngine names the provider-side
  // engine within that allowlist; local image/video generation registers as
  // 'local', which is the only engine a provider can currently advertise.
  // What may cross to a peer, and what may not:
  // docs/decisions/2026-08-20-federated-visual-prompts.md
  mediaProviderPeerId: z.string().uuid().optional(),
  mediaProviderEngine: z.string().trim().min(1).max(80).optional(),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// Numerics arrive as strings from FormData — coerce before Zod validation.
// `referenceStrengths` is a repeated key (one per slot), which arrives as a
// string OR an array of strings; coerce element-wise so Zod sees numbers.
export function coerceFormFields(body) {
  const numericFields = ['width', 'height', 'steps', 'cfgScale', 'guidance', 'seed', 'initImageStrength'];
  for (const f of numericFields) {
    if (typeof body[f] === 'string' && body[f] !== '') body[f] = Number(body[f]);
  }
  if (typeof body.quantize === 'string' && /^\d+$/.test(body.quantize)) body.quantize = Number(body.quantize);
  if (body.referenceStrengths != null) {
    const raw = Array.isArray(body.referenceStrengths) ? body.referenceStrengths : [body.referenceStrengths];
    body.referenceStrengths = raw.map((v) => (typeof v === 'string' && v !== '' ? Number(v) : v));
  }
  // Array fields are repeated multipart keys. A single selected value arrives
  // as a bare string, not a one-element array — wrap it so Zod accepts it.
  // `loraScales` numbers also arrive as strings, so coerce element-wise like
  // referenceStrengths above.
  for (const f of ['loraFilenames', 'loraPaths', 'referenceImageFiles']) {
    if (body[f] != null && !Array.isArray(body[f])) body[f] = [body[f]];
  }
  if (body.loraScales != null) {
    const raw = Array.isArray(body.loraScales) ? body.loraScales : [body.loraScales];
    body.loraScales = raw.map((v) => (typeof v === 'string' && v !== '' ? Number(v) : v));
  }
  // Multipart sends checkbox values as 'true' / 'false' strings; coerce to
  // bool so Zod's `z.boolean()` accepts them.
  for (const f of ['cleanC2PA', 'denoise', 'autoClean', 'verifyImage']) {
    if (typeof body[f] === 'string') body[f] = body[f] === 'true';
  }
  // Legacy single-flag clients: an explicit `autoClean` on the wire maps to
  // BOTH new flags (preserves the pre-split behavior) only when the caller
  // didn't also send the new fields. Modern clients that pass cleanC2PA /
  // denoise explicitly win.
  if (typeof body.autoClean === 'boolean') {
    if (typeof body.cleanC2PA !== 'boolean') body.cleanC2PA = body.autoClean;
    if (typeof body.denoise !== 'boolean') body.denoise = body.autoClean;
  }
  return body;
}

export const avatarSchema = z.object({
  name: z.string().max(100).optional(),
  characterClass: z.string().max(100).optional(),
  prompt: z.string().max(2000).optional(),
  // When set, the route persists the rendered path onto the singleton
  // character record itself (the character store has no id), so the client
  // skips the follow-up PUT /api/character round-trip.
  persistToCharacter: z.boolean().optional(),
});

// Upload a user-supplied image straight into the gallery (`data/images/`) so it
// rides the existing `image` peer-sync asset path. `data` is base64 (no data:
// URI prefix); the real format is sniffed server-side, so the schema only caps
// the legacy JSON request. Multipart uploads have no size cap.
export const uploadImageSchema = z.object({
  data: z.string().min(1).max(24 * 1024 * 1024),
});

// SynthID-defeat regen (issue #912). Body is optional — every field defaults
// server-side (strength → DEFAULT_REGEN_STRENGTH, steps → the model default,
// prompt → empty for minimal mutation). An empty/whitespace `prompt` is treated
// as "no prompt" by buildRegenParams, so the UI can send '' for the default.
export const regenerateSchema = z.object({
  strength: z.number().min(REGEN_STRENGTH_MIN).max(REGEN_STRENGTH_MAX).optional(),
  steps: z.number().int().min(1).max(50).optional(),
  prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  // 'flux' (default) = GPU img2img round-trip; 'light' = CPU-only spatial pass
  // for installs without a FLUX runner (strength/steps/prompt ignored).
  method: z.enum(['flux', 'light']).optional(),
  // Annotation re-render (issue #2036 phase 2): seed the img2img init image from
  // the saved flattened sketch (source + drawn strokes) instead of the raw
  // gallery file, so the marks reshape the render. GPU-only (light ignores the
  // init image); defaults to a higher denoise so the strokes take effect.
  annotated: z.boolean().optional(),
});

// Visible-watermark removal — erases the Gemini / Nano-Banana bottom-right ✦.
// Body is optional: with no fields the corner box is auto-sized to the
// sparkle's typical footprint. `size` overrides the square side; `region`
// pins an explicit box (each field clamped server-side into the image) for
// off-spec placements. All ints in pixels.
export const removeWatermarkSchema = z.object({
  size: z.number().int().min(1).max(4096).optional(),
  region: z.object({
    x: z.number().int().min(0).max(100000).optional(),
    y: z.number().int().min(0).max(100000).optional(),
    w: z.number().int().min(1).max(4096).optional(),
    h: z.number().int().min(1).max(4096).optional(),
  }).optional(),
});

// `mode` keeps tolerating a repeated key (array) and an unknown value: both fall back to the saved
// default below. `modelId` is a registry id, so a repeated or over-long one is refused.
export const statusQuerySchema = z.object({
  mode: z.union([z.string(), z.array(z.string())]).optional(),
  modelId: z.string().max(64).optional(),
});

export const regenAvailabilityQuerySchema = z.object({ filename: z.string().optional() });

// What the render would send, before it is sent (#11317). Same preparation and
// prompt builders as POST /generate; the form says which uploads it holds by
// count rather than sending their bytes, and nothing is staged or queued.
export const promptPreviewSchema = generateSchema.safeExtend({
  uploadedInitImage: z.boolean().optional(),
  uploadedReferenceCount: z.number().int().min(0).max(MAX_REFERENCE_IMAGES).optional(),
  reviewReference: z.boolean().optional(),
});
