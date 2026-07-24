/**
 * Sprites Routes — REST surface for the Sprite Manager.
 *
 * Phase 1 (#2895): library list/get, source-tree importer, record patch.
 * Phase 2 (#2896, reordered turnaround-first in #2979): character create + the
 * reference workflow — generate turnaround/main/anchor candidates through the
 * shared image-gen queue, review, then lock (normalize + dynamic chroma-key
 * selection). Generation is strictly user-triggered per the AI-provider policy;
 * locked artifacts are immutable (409 on regenerate/relock).
 */

import { Router } from 'express';
import { unlink } from 'fs/promises';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  spriteImportRequestSchema,
  spriteRecordUpdateSchema,
  spriteCreateSchema,
  spriteReferenceGenerateSchema,
  spriteReferenceLockSchema,
  spriteForkSchema,
  spriteWalkGenerateSchema,
  spriteWalkApproveSchema,
  spriteWalkReopenSchema,
  spriteWalkPostprocessSchema,
  spriteWalkTrimSchema,
  spritePublishBindingSchema,
  spriteAtlasCompileSchema,
  spriteAtlasPublishSchema,
  spriteAssetDeleteSchema,
} from '../lib/validation.js';
import { z } from 'zod';
import { optionalUploadFields } from '../lib/multipart.js';
import {
  listRecords, getRecordWithAssets, createCharacter, deleteRecord,
} from '../services/sprites/records.js';
import { importFromSource } from '../services/sprites/importer.js';
import {
  getReferenceSet, startReferenceGeneration, lockReference, patchSpriteRecord,
  listReferenceSources, listSpriteThumbnails, forkSprite,
} from '../services/sprites/reference.js';
import { resolveSpriteAssetPrompt } from '../services/sprites/assetPrompt.js';
import {
  getWalkState, startWalkGeneration, approveWalkDirection, rerunWalkPostprocess, unlockWalkSet,
  reopenWalkDirection,
} from '../services/sprites/walk.js';
import { saveLoopTrim } from '../services/sprites/walkTrims.js';
import { compileAtlas, getAtlasState } from '../services/sprites/atlas.js';
import { setPublishBinding, publishAtlas } from '../services/sprites/publish.js';
import { deleteSpriteAsset } from '../services/sprites/assets.js';

const router = Router();

const MAX_REFERENCE_UPLOAD_BYTES = 20 * 1024 * 1024;
const ACCEPTED_REFERENCE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

const referenceUpload = optionalUploadFields(['referenceImage'], {
  limits: { fileSize: MAX_REFERENCE_UPLOAD_BYTES },
  // multer-style (req, file, cb) — streamMultipart requires the callback to
  // be invoked synchronously (see routes/imageGen.js for the sibling).
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_REFERENCE_MIME.has((file.mimetype || '').toLowerCase())),
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listRecords());
}));

// Characters with a locked main reference — the pool that can seed a new main
// (i2i) or be forked. MUST precede `/:id` so the literal path isn't captured as
// an id param.
router.get('/reference-sources', asyncHandler(async (_req, res) => {
  res.json(await listReferenceSources());
}));

// A representative thumbnail per record for the Library catalog — every kind,
// not just reference-workflow characters. MUST precede `/:id`.
router.get('/thumbnails', asyncHandler(async (_req, res) => {
  res.json(await listSpriteThumbnails());
}));

// Create a character record — the entry point of the reference workflow.
// Id derivation and the kind live in the service (createCharacter).
router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(spriteCreateSchema, req.body);
  res.status(201).json(await createCharacter(input));
}));

// Import approved production assets from a source tree. A direct user action
// (never boot-triggered) per the AI Provider / cold-start policy — though this
// endpoint itself makes no AI calls, only file copies.
router.post('/import', asyncHandler(async (req, res) => {
  const input = validateRequest(spriteImportRequestSchema, req.body);
  res.json(await importFromSource(input));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const detail = await getRecordWithAssets(req.params.id);
  if (!detail) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  const isCharacter = detail.record.kind === 'character';
  const [reference, walk, atlas] = isCharacter
    ? await Promise.all([
      getReferenceSet(req.params.id),
      getWalkState(req.params.id),
      getAtlasState(req.params.id),
    ])
    : [null, null, null];
  res.json({ ...detail, reference, walk, atlas });
}));

// The generation prompt behind one on-disk asset (record-relative `path`) —
// reference candidate, locked main/anchor, or walk-animation render — so the
// client's preview modals can show + copy it. Returns `null` for an asset with
// no prompt provenance (imports, manifests). Two path segments, so it never
// collides with the single-segment `/:id` GET above.
router.get('/:id/asset-prompt', asyncHandler(async (req, res) => {
  const { path } = validateRequest(z.object({ path: z.string().min(1) }), req.query);
  res.json(await resolveSpriteAssetPrompt(req.params.id, path));
}));

// Queue one reference candidate render (main or a directional anchor).
// Accepts JSON, or multipart with an optional `referenceImage` file for the
// main target (an uploaded visual design reference → i2i).
router.post('/:id/reference/generate', referenceUpload, asyncHandler(async (req, res) => {
  // Capture + register the temp-file sweep BEFORE validation — a 400 thrown
  // by validateRequest would otherwise leak the already-finalized upload.
  // The service moves the file on success, so the unlink is a harmless
  // ENOENT there.
  const file = req.files?.referenceImage;
  const upload = file ? { tempPath: file.path, originalname: file.originalname } : null;
  if (upload) res.on('close', () => { unlink(upload.tempPath).catch(() => {}); });
  const body = validateRequest(spriteReferenceGenerateSchema, req.body ?? {});
  // A design upload seeds the identity root, which is always the turnaround
  // sheet (#2979, #2996) — the main and every anchor derive from that sheet, so
  // there is nowhere for a seed of their own to go.
  if (upload && body.target !== 'turnaround') {
    throw new ServerError('Reference image uploads seed the turnaround sheet — the main reference and directional anchors always derive from it', { status: 400, code: 'UPLOAD_TURNAROUND_ONLY' });
  }
  res.json(await startReferenceGeneration(req.params.id, body, upload));
}));

// Lock a reviewed candidate: normalize onto the canonical key-color square
// and freeze it in the reference-set manifest. 409 when already locked.
router.post('/:id/reference/lock', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteReferenceLockSchema, req.body);
  res.json(await lockReference(req.params.id, body));
}));

// Fork `:id` into a new character seeded (image+text→image) from its locked
// main reference. Creates the record then queues the main render; returns the
// new record + jobId. User-triggered per the AI-provider policy.
router.post('/:id/fork', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteForkSchema, req.body);
  res.status(201).json(await forkSprite(req.params.id, body));
}));

// Phase 3 (#2897): queue one grok walk video for a locked directional
// anchor. User-triggered per the AI-provider policy; everything after the
// clip is deterministic local postprocessing.
router.post('/:id/walk/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteWalkGenerateSchema, req.body);
  res.json(await startWalkGeneration(req.params.id, body));
}));

// Approve one direction's packaged candidate; the 8th approval freezes the
// finalized walk set (immutable — 409 on later generate/approve).
router.post('/:id/walk/approve', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteWalkApproveSchema, req.body);
  res.json(await approveWalkDirection(req.params.id, body));
}));

// Un-freeze a finalized walk set so it can be revised in place (#2933
// follow-up): removes the frozen walk-set file and re-opens every direction,
// preserving the rendered clips. 409s a legacy source-pipeline import. No body.
router.post('/:id/walk/unlock', asyncHandler(async (req, res) => {
  res.json(await unlockWalkSet(req.params.id));
}));

// Re-open ONE approved direction (finer-grained than unlock) so it can be
// regenerated/reprocessed/re-approved — the user noticed one walk is too fast
// or wrong. Un-finalizes a frozen set but keeps other directions' approvals.
router.post('/:id/walk/reopen', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteWalkReopenSchema, req.body);
  res.json(await reopenWalkDirection(req.params.id, body));
}));

// Re-run the deterministic postprocess for a run whose video already landed
// (crash recovery / determinism verification). No AI call involved.
router.post('/:id/walk/postprocess', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteWalkPostprocessSchema, req.body);
  res.json(await rerunWalkPostprocess(req.params.id, body));
}));

// Non-destructive loop trim: re-pack enabled frames from a packed strip into
// a versioned trimmed strip + preview GIF. Never mutates the source atlas.
router.post('/:id/walk/trim', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteWalkTrimSchema, req.body);
  res.status(201).json(await saveLoopTrim(req.params.id, body));
}));

// Phase 4 (#2898): atlas compile + publish-to-managed-app. Compile is
// deterministic local work (no AI call); publish additionally requires a
// configured binding and is the only path that writes outside data/.
router.post('/:id/atlas/compile', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteAtlasCompileSchema, req.body ?? {});
  res.json(await compileAtlas(req.params.id, body));
}));

// Set (or clear, with binding: null) the publish binding. App existence and
// path anchoring are validated here so a bad binding fails at save time, not
// at publish time.
router.put('/:id/publish-binding', asyncHandler(async (req, res) => {
  const { binding } = validateRequest(z.object({ binding: spritePublishBindingSchema }), req.body);
  res.json(await setPublishBinding(req.params.id, binding));
}));

router.post('/:id/atlas/publish', asyncHandler(async (req, res) => {
  const body = validateRequest(spriteAtlasPublishSchema, req.body ?? {});
  res.json(await publishAtlas(req.params.id, body));
}));

// Chroma-key changes route through patchSpriteRecord, which re-checks the
// lock state inside the same per-record write tail as `/reference/lock`
// (409 CHROMA_KEY_LOCKED after the main freezes).
router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(spriteRecordUpdateSchema, req.body);
  res.json(await patchSpriteRecord(req.params.id, patch));
}));

// Delete one on-disk asset — an old runtime atlas version (PNG + manifest
// removed together) or a superseded reference/candidate render — by its
// record-relative `path`. Refuses the live atlas + the state index files;
// confinement and the per-record write tail live in the service.
router.delete('/:id/assets', asyncHandler(async (req, res) => {
  const { path } = validateRequest(spriteAssetDeleteSchema, req.query);
  res.json(await deleteSpriteAsset(req.params.id, path));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteRecord(req.params.id));
}));

export default router;
