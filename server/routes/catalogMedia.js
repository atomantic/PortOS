/** Read and manage library attachments on catalog ingredients. */

import { Router } from 'express';
import * as catalogDB from '../services/catalog/catalogDB.js';
import { catalogEvents } from '../services/catalog/catalogEvents.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  catalogMediaAttachSchema, catalogMediaLibraryPatchSchema, catalogMediaFromMoodBoardSchema,
  catalogMediaLibraryQuerySchema, catalogMediaDetachSchema, catalogMediaFileUploadSchema,
  catalogMediaVoiceMemoSchema, catalogPortraitSetSchema, catalogGeneratedImageAttachSchema,
} from '../lib/catalog/catalogValidation.js';
import { resolveImageInputPath } from '../lib/fileUtils.js';
import { readImageGenerationMetadata, uploadIngredientMediaFile, recordIngredientVoiceMemo } from '../services/catalog/catalogMedia.js';
import { getBoard as getMoodBoard } from '../services/moodBoard/index.js';
import { filterLibraryMedia, parseLibraryMediaKey, inferAgeFromText } from '../lib/catalog/catalogMediaLibrary.js';

const router = Router();

// --- Ingredient media attachments ---------------------------------------
// `media_key` is a reference into the media library (data/images + history
// sidecar); the catalog never stores the bytes. The attach/portrait routes
// reject a key that doesn't resolve against the local IMAGE library with a 422
// so a typo can't persist a permanently-broken reference. Federated keys that
// don't resolve are tolerated (they ride in via sync) and surface on the
// integrity endpoint instead — that's a different code path that never throws.
//
// Only image kinds resolve against the gallery today; audio/video/document
// keys have no library resolver yet, so they skip the existence guard.
const IMAGE_MEDIA_KINDS = new Set(['portrait', 'reference']);

router.get('/ingredients/:id/media', asyncHandler(async (req, res) => {
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const filters = validateRequest(catalogMediaLibraryQuerySchema, req.query);
  const media = await catalogDB.listMediaForIngredient(req.params.id);
  // No filter = the unchanged full list; any filter narrows by the Casting library fields.
  res.json(Object.keys(filters).length ? filterLibraryMedia(media, { ...filters, guide: filters.guide === 'true' ? true : undefined }) : media);
}));

// Edit a media row's Casting library fields (variant/tags/guide). 409 past 4 guides.
router.patch('/ingredients/:id/media/library', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaLibraryPatchSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const { mediaKey, kind, ...patch } = body;
  const media = await catalogDB.updateMediaLibrary(req.params.id, mediaKey, kind, patch).catch((err) => {
    if (err?.status) throw new ServerError(err.message, { status: err.status });
    throw err;
  });
  res.json(media);
  catalogEvents.emit('primitive-changed', { ingredientId: ing.id });
}));

// Attach mood-board items (image:/video: keys) as references in one call,
// tagging each with the given variant/tags (or an age read from its caption).
router.post('/ingredients/:id/media/from-mood-board', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaFromMoodBoardSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  const board = await getMoodBoard(body.boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404 });
  const items = new Map((board.items || []).map((item) => [item.id, item]));
  const attached = [];
  const skipped = [];
  for (const itemId of body.itemIds) {
    const item = items.get(itemId);
    const parsed = parseLibraryMediaKey(item?.mediaKey);
    if (!parsed || (parsed.kind === 'reference' && !resolveImageInputPath(parsed.mediaKey))) { skipped.push(itemId); continue; }
    const caption = typeof item.caption === 'string' ? item.caption.slice(0, 2000) : null;
    const metadata = parsed.kind === 'reference' ? await readImageGenerationMetadata(parsed.mediaKey) : {};
    await catalogDB.attachMedia(req.params.id, parsed.mediaKey, parsed.kind, {
      role: null, caption,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
    const age = body.variant?.age ?? (body.inferAge ? inferAgeFromText(caption) : undefined);
    const variant = { ...(body.variant || {}), ...(age !== undefined ? { age } : {}) };
    const patch = { ...(Object.keys(variant).length ? { variant } : {}), ...(body.tags ? { tags: body.tags } : {}) };
    attached.push(Object.keys(patch).length ? await catalogDB.updateMediaLibrary(req.params.id, parsed.mediaKey, parsed.kind, patch) : { mediaKey: parsed.mediaKey, kind: parsed.kind });
  }
  res.status(201).json({ attached, skipped });
}));

router.post('/ingredients/:id/media', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaAttachSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  // Only IMAGE kinds resolve against the gallery today, so only they get the
  // existence guard — attaching an audio/video/document key (no library
  // resolver yet) stores the reference without a 422. The integrity endpoint
  // mirrors this scoping when reporting missing assets.
  if (IMAGE_MEDIA_KINDS.has(body.kind) && !resolveImageInputPath(body.mediaKey)) {
    throw new ServerError(`Media key "${body.mediaKey}" not found in the media library`, { status: 422 });
  }
  const metadata = IMAGE_MEDIA_KINDS.has(body.kind)
    ? await readImageGenerationMetadata(body.mediaKey)
    : {};
  const media = await catalogDB.attachMedia(req.params.id, body.mediaKey, body.kind, {
    role: body.role ?? null,
    caption: body.caption ?? null,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
  res.status(201).json(media);
}));

router.post('/ingredients/:id/media/portrait', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPortraitSetSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  if (!resolveImageInputPath(body.mediaKey)) {
    throw new ServerError(`Media key "${body.mediaKey}" not found in the media library`, { status: 422 });
  }
  const metadata = await readImageGenerationMetadata(body.mediaKey);
  const media = await catalogDB.setPortraitMedia(req.params.id, body.mediaKey, {
    role: body.role ?? null,
    caption: body.caption ?? null,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  });
  res.status(201).json(media);
}));

// The mounted page's optimistic attach for a render it just watched complete.
// It shares attachGeneratedMedia with the completion hook, so whichever lands
// second sees the first under the ingredient lock and leaves one row (#13833).
router.post('/ingredients/:id/media/generated', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogGeneratedImageAttachSchema, req.body);
  const ing = await catalogDB.getIngredient(req.params.id);
  if (!ing) throw new ServerError('Ingredient not found', { status: 404 });
  if (!resolveImageInputPath(body.mediaKey)) {
    throw new ServerError(`Media key "${body.mediaKey}" not found in the media library`, { status: 422 });
  }
  const metadata = await readImageGenerationMetadata(body.mediaKey);
  const result = await catalogDB.attachGeneratedMedia(req.params.id, body.mediaKey,
    Object.keys(metadata).length > 0 ? { metadata } : {});
  res.status(result.attached ? 201 : 200).json(result);
}));

router.delete('/ingredients/:id/media', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaDetachSchema, req.body);
  await catalogDB.detachMedia(req.params.id, body.mediaKey, body.kind);
  res.status(204).end();
}));

// Upload a file (drag-drop / picker) straight onto an ingredient: the service
// stores it in the matching federating library dir (image→data/images as PNG,
// audio→data/audio, video→data/videos) and attaches the reference. The 404 for a
// missing ingredient is raised inside the service.
router.post('/ingredients/:id/media/upload', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaFileUploadSchema, req.body);
  const media = await uploadIngredientMediaFile({ ingredientId: req.params.id, ...body });
  res.status(201).json(media);
}));

// Record a voice memo onto an ingredient: transcribe via Whisper, persist the
// audio, and attach a kind:'audio' row with the transcript in caption.
router.post('/ingredients/:id/media/voice', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaVoiceMemoSchema, req.body);
  const result = await recordIngredientVoiceMemo({ ingredientId: req.params.id, ...body });
  res.status(201).json(result);
}));

export default router;
