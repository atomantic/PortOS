/**
 * Sprites — reference workflow orchestration (issue #2896, phase 2).
 *
 * Ports the source pipeline's stage 1–2: create a character, generate main-
 * reference candidates (text and/or an uploaded visual reference), freeze the
 * approved main as the immutable identity root, then derive and lock the 8
 * directional anchors from it. Generation rides the shared media-job queue
 * (`enqueueJob` kind:'image' with a `spriteRef` destination tag — the
 * completion hook in services/spriteReferenceImageHook.js files finished
 * renders into reference/candidates/); locking is deterministic sharp work
 * (normalize.js) plus the dynamic chroma-key selection (chromaKey.js).
 *
 * Immutability contract: a locked artifact is never regenerated or
 * overwritten — locked targets 409 on generate/lock, and versioned filenames
 * (`-vN`) always land on the first free version.
 */

import { join } from 'path';
import { readdir, copyFile } from 'fs/promises';
import {
  PATHS, ensureDir, sha256File, atomicWrite, pathExists, readJSONFile,
  importFileToDir, listDirectoryByExtension,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { IMAGE_GEN_MODE, resolveQueueImageMode, CODEX_IMAGEGEN_DEFAULT_MODEL } from '../imageGen/modes.js';
import { resolveImageCleaners } from '../imageGen/index.js';
import { getSettings } from '../settings.js';
import { getRecord, updateRecord } from './records.js';
import { spriteDir, resolveSpriteAssetPath } from './paths.js';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, anchorIdForDirection,
  buildMainReferencePrompt, buildAnchorPrompt,
} from './prompts.js';
import { pickChromaKey, keyProximityWarning, CHROMA_KEY_HEXES, DEFAULT_CHROMA_KEY } from './chromaKey.js';
import { analyzeForeground, paletteFromAnalysis, normalizeFromAnalysis, normalizeAnchorFrame } from './normalize.js';

// Default i2i strengths: anchors redraw a NEW facing from the main (mostly
// follow the prompt, borrow identity), an uploaded visual reference guides
// the main more tightly. Local mflux honors the number; codex/grok attach
// the image and pick their own fidelity.
const ANCHOR_DEFAULT_STRENGTH = 0.8;
const UPLOAD_DEFAULT_STRENGTH = 0.65;

const manifestRelPath = (id) => `reference/${id}-reference-set-v1.json`;

// Serialize the manifest read-modify-write per record: two overlapping locks
// (or a generate racing a lock) would otherwise both load the pre-write
// manifest and the second save would erase the first's locked state —
// breaking the immutability contract. Same convention as the completion
// hook's per-record queue.
const manifestWriteTail = createKeyCachedQueue();

// Phase-1 imported manifests are copied verbatim from the source pipeline
// and carry repo-root paths (`art-source/sprites/<id>/reference/...`), while
// the files themselves live record-relative under data/sprites/<id>/.
// Rebase on read so imported characters render and derive anchors correctly.
function rebaseLegacyPath(p, recordId) {
  const marker = `art-source/sprites/${recordId}/`;
  return typeof p === 'string' && p.startsWith(marker) ? p.slice(marker.length) : p;
}

async function loadManifest(recordId) {
  const manifest = await readJSONFile(join(spriteDir(recordId), manifestRelPath(recordId)), null);
  if (!manifest) return null;
  if (manifest.mainReference) {
    manifest.mainReference.path = rebaseLegacyPath(manifest.mainReference.path, recordId);
    manifest.mainReference.lockedFrom = rebaseLegacyPath(manifest.mainReference.lockedFrom, recordId);
  }
  for (const anchor of manifest.anchors || []) {
    anchor.path = rebaseLegacyPath(anchor.path, recordId);
    anchor.lockedFrom = rebaseLegacyPath(anchor.lockedFrom, recordId);
  }
  return manifest;
}

async function saveManifest(recordId, manifest) {
  const abs = join(spriteDir(recordId), manifestRelPath(recordId));
  await ensureDir(join(spriteDir(recordId), 'reference'));
  await atomicWrite(abs, manifest);
}

function seedManifest(recordId) {
  return {
    schemaVersion: 1,
    manifestId: `${recordId}-reference-set-v1`,
    status: 'needs-main-reference',
    characterFamily: recordId,
    projection: 'flat',
    rule: 'Every anchor descends from the frozen main reference. Locked anchors are immutable evidence. Walk cycles are conditioned only on a locked directional anchor plus the deterministic pose scaffold, never on prior walk output, and the identity anchor is never regenerated.',
    chromaKey: null,
    mainReference: { path: null, role: 'immutable-root', background: 'chroma-key', locked: false },
    anchors: SPRITE_DIRECTIONS.map((direction) => ({
      id: anchorIdForDirection(direction),
      kind: 'walk-anchor',
      direction,
      status: 'pending',
      source: direction === 'south' ? 'main-reference' : 'derive-from-main',
    })),
    note: 'walk-south and walk-north double as the front/back idle stills, so no separate idle anchors are kept.',
  };
}

async function requireCharacter(recordId) {
  const record = await getRecord(recordId);
  if (!record) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  if (record.kind !== 'character') {
    throw new ServerError('Reference workflow applies to character records only', { status: 400, code: 'NOT_A_CHARACTER' });
  }
  return record;
}

// First free `-vN` filename — locked artifacts are never overwritten; a
// correction after a crash (or a future unlock flow) lands on the next
// version instead of replacing evidence.
async function nextVersionPath(dir, base) {
  for (let n = 1; ; n++) {
    const rel = `${base}-v${n}.png`;
    if (!await pathExists(join(dir, rel))) return rel;
  }
}

async function nextCandidateName(candidatesDir, anchorId) {
  let entries = [];
  try {
    entries = await readdir(candidatesDir);
  } catch {
    // dir absent → first candidate
  }
  const re = new RegExp(`^${anchorId}-candidate-(\\d+)\\.png$`);
  const max = entries.reduce((m, name) => {
    const match = re.exec(name);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `${anchorId}-candidate-${String(max + 1).padStart(2, '0')}.png`;
}

function findAnchor(manifest, anchorId) {
  return manifest.anchors.find((a) => a.id === anchorId) || null;
}

/**
 * Reference-set view for the detail endpoint: the manifest (null until the
 * first generate) plus the reviewable candidates parsed from their
 * generation sidecars, newest first per target.
 */
export async function getReferenceSet(recordId) {
  const manifest = await loadManifest(recordId);
  const candidatesDir = join(spriteDir(recordId), 'reference', 'candidates');
  const candidates = (await listDirectoryByExtension(candidatesDir, {
    extensions: ['.png'],
    mapEntry: async (name) => {
      const sidecar = await readJSONFile(join(candidatesDir, `${name.replace(/\.png$/, '')}.generation.json`), null);
      return {
        path: `reference/candidates/${name}`,
        target: sidecar?.target || null,
        anchorId: sidecar?.anchorId || null,
        chromaKey: sidecar?.chromaKey || null,
        mode: sidecar?.mode || null,
        model: sidecar?.model || null,
        generatedAt: sidecar?.generatedAt || null,
      };
    },
  }))
    .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || '') || a.path.localeCompare(b.path));
  return { manifest, candidates };
}

/**
 * Queue one main-reference or directional-anchor candidate render.
 * User-triggered only (route-invoked); never called at boot.
 *
 * `upload` is an optional `{ tempPath, originalname }` from the route's
 * multipart parse (main target only) — copied into the record's
 * reference/uploads/ so provenance survives the temp-file sweep.
 */
export function startReferenceGeneration(recordId, body, upload = null) {
  return manifestWriteTail(recordId, () => startReferenceGenerationImpl(recordId, body, upload));
}

async function startReferenceGenerationImpl(recordId, body, upload = null) {
  const record = await requireCharacter(recordId);
  const manifest = (await loadManifest(recordId)) || seedManifest(recordId);
  const target = body.target;
  // Once the main is locked, the manifest's key is canonical (set at lock —
  // possibly auto-selected); a later record-level repin must not fork
  // subsequent anchors onto a different background than the frozen set.
  const genKey = manifest.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY;
  const settings = await getSettings();
  const mode = resolveQueueImageMode(body.mode, settings);

  let prompt;
  let initImagePath;
  let initImageStrength = Number.isFinite(body.initImageStrength) ? body.initImageStrength : undefined;
  let anchorId;
  let direction;

  if (target === 'main') {
    if (manifest.mainReference.locked) {
      throw new ServerError('Main reference is locked — corrections require a new character version, never regeneration', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    const designPrompt = typeof body.designPrompt === 'string' ? body.designPrompt.trim() : '';
    if (!designPrompt && !upload) {
      throw new ServerError('Provide a design prompt and/or a reference image', { status: 400, code: 'DESIGN_INPUT_REQUIRED' });
    }
    anchorId = anchorIdForDirection('south');
    direction = 'south';
    prompt = buildMainReferencePrompt({ name: record.name, designPrompt, chromaKey: genKey });
    if (upload) {
      // Shared temp-import (uuid-prefixed name, EXDEV-safe copy+unlink) —
      // the upload persists in the record dir as design provenance.
      const uploadsDir = join(spriteDir(recordId), 'reference', 'uploads');
      const { filename } = await importFileToDir(upload.tempPath, upload.originalname || 'design-reference.png', uploadsDir);
      initImagePath = join(uploadsDir, filename);
      initImageStrength ??= UPLOAD_DEFAULT_STRENGTH;
    }
    if (designPrompt) manifest.designPrompt = designPrompt;
    // Only the main branch mutates (or may have just seeded) the manifest —
    // the anchor branch requires a locked main, so its manifest already
    // exists on disk unchanged.
    await saveManifest(recordId, manifest);
  } else {
    if (!ANCHOR_DIRECTIONS.includes(target)) {
      throw new ServerError(`Unknown reference target: ${target}`, { status: 400, code: 'INVALID_TARGET' });
    }
    if (!manifest.mainReference.locked) {
      throw new ServerError('Lock the main reference before deriving directional anchors', { status: 409, code: 'MAIN_NOT_LOCKED' });
    }
    direction = target;
    anchorId = anchorIdForDirection(direction);
    const anchor = findAnchor(manifest, anchorId);
    if (anchor?.status === 'locked') {
      throw new ServerError(`Anchor ${anchorId} is locked — locked anchors are immutable`, { status: 409, code: 'REFERENCE_LOCKED' });
    }
    prompt = buildAnchorPrompt({ name: record.name, direction, chromaKey: genKey });
    initImagePath = resolveSpriteAssetPath(recordId, manifest.mainReference.path);
    if (!await pathExists(initImagePath)) {
      throw new ServerError('Locked main reference file is missing on disk', { status: 500, code: 'MAIN_REFERENCE_MISSING' });
    }
    initImageStrength ??= ANCHOR_DEFAULT_STRENGTH;
  }

  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
  const codexModel = body.model || settings.imageGen?.codex?.model || CODEX_IMAGEGEN_DEFAULT_MODEL;
  // The model the provider will ACTUALLY run, for candidate provenance —
  // grok picks its model internally, so its sidecars record null.
  const effectiveModel = mode === IMAGE_GEN_MODE.CODEX
    ? codexModel
    : mode === IMAGE_GEN_MODE.LOCAL
      ? (body.model || settings.imageGen?.local?.modelId || null)
      : null;
  const baseParams = {
    prompt,
    ...(initImagePath ? { initImagePath, initImageStrength } : {}),
    cleanC2PA,
    denoise,
    // Destination tag the completion hook files the render by.
    spriteRef: {
      recordId, target, direction, anchorId, chromaKey: genKey, mode, model: effectiveModel,
      ...(target === 'main' && body.designPrompt ? { designPrompt: body.designPrompt } : {}),
    },
  };
  const params = mode === IMAGE_GEN_MODE.CODEX
    ? { mode, codexPath: settings.imageGen?.codex?.codexPath, model: codexModel, effort: body.effort || settings.imageGen?.codex?.effort, ...baseParams }
    : mode === IMAGE_GEN_MODE.GROK
      ? { mode, grokPath: settings.imageGen?.grok?.grokPath, aspectRatio: settings.imageGen?.grok?.aspectRatio, ...baseParams }
      : { mode, pythonPath: settings.imageGen?.local?.pythonPath || null, ...(body.model ? { modelId: body.model } : {}), ...baseParams };

  const { jobId } = enqueueJob({ kind: 'image', params, owner: 'sprites' });
  console.log(`🧍 sprite reference render queued ${recordId}/${anchorId} mode=${mode} jobId=${jobId.slice(0, 8)}`);
  return { jobId, mode, target, anchorId };
}

/**
 * Completion-hook attach: copy a finished render from the shared image
 * gallery into the record's reference/candidates/ with a generation sidecar.
 * Returns the candidate rel path (falsy result = hook logs a skip).
 */
export async function attachReferenceCandidate(ctx) {
  const { recordId, anchorId, filename } = ctx;
  const src = join(PATHS.images, filename);
  if (!await pathExists(src)) return null;
  const candidatesDir = join(spriteDir(recordId), 'reference', 'candidates');
  await ensureDir(candidatesDir);
  const name = await nextCandidateName(candidatesDir, anchorId);
  const dest = join(candidatesDir, name);
  await copyFile(src, dest);
  const relPath = `reference/candidates/${name}`;
  await atomicWrite(join(candidatesDir, `${name.replace(/\.png$/, '')}.generation.json`), {
    schemaVersion: 1,
    kind: 'sprite-reference-generation',
    characterId: recordId,
    target: ctx.target,
    anchorId,
    direction: ctx.direction,
    chromaKey: ctx.chromaKey || null,
    mode: ctx.mode || null,
    model: ctx.model || null,
    jobId: ctx.jobId || null,
    ...(ctx.designPrompt ? { designPrompt: ctx.designPrompt } : {}),
    generatedAt: new Date().toISOString(),
    candidatePath: relPath,
    candidateSha256: await sha256File(dest),
    sourceFilename: filename,
  });
  return { candidatePath: relPath };
}

async function loadCandidateSidecar(candAbs) {
  return readJSONFile(`${candAbs.replace(/\.png$/, '')}.generation.json`, null);
}

/**
 * Lock a reviewed candidate: normalize it onto the canonical key-color
 * square and record it in the manifest as immutable evidence. Locking the
 * main also runs the dynamic chroma-key selection (unless the user already
 * pinned one on the record).
 */
export function lockReference(recordId, args) {
  return manifestWriteTail(recordId, () => lockReferenceImpl(recordId, args));
}

async function lockReferenceImpl(recordId, { target, candidate }) {
  const record = await requireCharacter(recordId);
  // Seed on demand — a candidate may predate the manifest (e.g. files placed
  // by an import or a crash-recovered tree); the lock is what makes it real.
  const manifest = (await loadManifest(recordId)) || seedManifest(recordId);
  if (typeof candidate !== 'string' || !candidate.startsWith('reference/candidates/')) {
    throw new ServerError('Candidate must be a reference/candidates/ path', { status: 400, code: 'INVALID_CANDIDATE' });
  }
  const candAbs = resolveSpriteAssetPath(recordId, candidate);
  if (!await pathExists(candAbs)) {
    throw new ServerError(`Candidate not found: ${candidate}`, { status: 404, code: 'CANDIDATE_NOT_FOUND' });
  }
  const refDir = join(spriteDir(recordId), 'reference');
  const sidecar = await loadCandidateSidecar(candAbs);
  // A candidate generated for one facing must not land in another slot — a
  // misclick would freeze the wrong pose as immutable evidence.
  if (sidecar?.target && sidecar.target !== target) {
    throw new ServerError(`Candidate was generated for target "${sidecar.target}", not "${target}"`, { status: 400, code: 'CANDIDATE_TARGET_MISMATCH' });
  }
  // Mask on the key the candidate was GENERATED against (its actual
  // background), which may differ from the key selected at lock time.
  const maskKey = sidecar?.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY;
  const now = new Date().toISOString();

  if (target === 'main') {
    if (manifest.mainReference.locked) {
      throw new ServerError('Main reference is already locked', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    // Dynamic key selection (#2895): histogram the character's own palette
    // and pick the standard key farthest from it in hue — unless the user
    // already pinned a key on the record. One analyzeForeground decode feeds
    // the palette and the composite; the palette is computed even when
    // pinned because the clip warning below needs it.
    const analysis = await analyzeForeground(candAbs, maskKey);
    const palette = paletteFromAnalysis(analysis);
    const userPinned = CHROMA_KEY_HEXES.includes(record.chromaKey);
    const auto = userPinned ? null : pickChromaKey(palette);
    const selectedKey = userPinned ? record.chromaKey : auto.hex;
    // Selection only sees pixels that SURVIVED the generation-key mask —
    // exact-key details (magenta garment on the magenta default) are already
    // gone from the palette, so surface the risk instead of silently locking
    // a clipped identity root.
    const clipWarning = keyProximityWarning(palette, maskKey);
    const rel = `reference/${await nextVersionPath(refDir, `${recordId}-walk-south`)}`;
    const destAbs = join(spriteDir(recordId), rel);
    await normalizeFromAnalysis(analysis, candAbs, destAbs, selectedKey);
    const sha256 = await sha256File(destAbs);
    manifest.chromaKey = selectedKey;
    manifest.chromaKeyAutoSelected = !userPinned;
    manifest.chromaKeyWarning = [auto?.warning, clipWarning].filter(Boolean).join(' — ') || null;
    manifest.mainReference = {
      ...manifest.mainReference,
      path: rel,
      background: 'chroma-key',
      locked: true,
      lockedFrom: candidate,
      lockedAt: now,
      sha256,
    };
    const south = findAnchor(manifest, anchorIdForDirection('south'));
    if (south) Object.assign(south, { status: 'locked', path: rel, lockedFrom: candidate, sha256 });
    manifest.status = 'in-progress';
    await saveManifest(recordId, manifest);
    await updateRecord(recordId, { chromaKey: selectedKey, status: 'reference' });
  } else {
    if (!ANCHOR_DIRECTIONS.includes(target)) {
      throw new ServerError(`Unknown reference target: ${target}`, { status: 400, code: 'INVALID_TARGET' });
    }
    if (!manifest.mainReference.locked) {
      throw new ServerError('Lock the main reference first', { status: 409, code: 'MAIN_NOT_LOCKED' });
    }
    const anchorId = anchorIdForDirection(target);
    const anchor = findAnchor(manifest, anchorId);
    if (!anchor) throw new ServerError(`Unknown anchor: ${anchorId}`, { status: 400, code: 'INVALID_TARGET' });
    if (anchor.status === 'locked') {
      throw new ServerError(`Anchor ${anchorId} is already locked`, { status: 409, code: 'REFERENCE_LOCKED' });
    }
    // Manifest key is canonical after main lock — see startReferenceGeneration.
    const canvasKey = manifest.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY;
    const rel = `reference/${await nextVersionPath(refDir, `${recordId}-${anchorId}`)}`;
    const destAbs = join(spriteDir(recordId), rel);
    await normalizeAnchorFrame(candAbs, destAbs, { maskKeyHex: maskKey, canvasKeyHex: canvasKey });
    Object.assign(anchor, {
      status: 'locked', path: rel, lockedFrom: candidate, lockedAt: now, sha256: await sha256File(destAbs),
    });
    const allLocked = manifest.anchors.every((a) => a.status === 'locked');
    if (allLocked) manifest.status = 'complete';
    await saveManifest(recordId, manifest);
    if (allLocked) await updateRecord(recordId, { status: 'reference-complete' });
  }
  console.log(`🔒 sprite reference locked ${recordId}/${target} from ${candidate}`);
  return getReferenceSet(recordId);
}
