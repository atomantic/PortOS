/**
 * Sprites — reference workflow orchestration (issue #2896, phase 2).
 *
 * Ports the source pipeline's stage 1–2, reordered turnaround-first (#2979):
 * create a character, generate turnaround-sheet candidates (text and/or an
 * uploaded visual reference), freeze the approved sheet as the immutable
 * identity root, then derive the main (walk-south) from its front panel and
 * each of the 7 remaining directional anchors from the panel showing that
 * side. A character created before #2979 is main-first (manifest
 * `schemaVersion` 1) and backfills a sheet from its locked main before it can
 * derive further anchors. Generation rides the shared media-job queue
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
  importFileToDir, listDirectoryByExtension, resolveGalleryImage,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import {
  IMAGE_GEN_MODE, resolveQueueImageMode,
  CODEX_IMAGEGEN_DEFAULT_MODEL, LOCAL_IMAGEGEN_DEFAULT_MODEL,
} from '../imageGen/modes.js';
import { resolveImageCleaners } from '../imageGen/index.js';
import { getSettings } from '../settings.js';
import { getRecord, updateRecord, listRecords, createCharacter } from './records.js';
import { spriteDir, resolveSpriteAssetPath, listSpriteAssets } from './paths.js';
import {
  SPRITE_DIRECTIONS, ANCHOR_DIRECTIONS, anchorIdForDirection, TURNAROUND_VIEWS, TURNAROUND_ID,
  buildMainReferencePrompt, buildAnchorPrompt, buildTurnaroundPrompt,
} from './prompts.js';
import { pickChromaKey, keyProximityWarning, CHROMA_KEY_HEXES, DEFAULT_CHROMA_KEY } from './chromaKey.js';
import {
  analyzeForeground, paletteFromAnalysis, normalizeFromAnalysis, recompositeOnKey,
} from './normalize.js';

// Default i2i strengths: a render that redraws a NEW figure from the frozen
// sheet (every anchor, and the main in the turnaround-first flow) mostly
// follows the prompt and borrows identity; an uploaded visual reference guides
// the turnaround it seeds more tightly. Local mflux honors the number;
// codex/grok attach the image and pick their own fidelity.
const ANCHOR_DEFAULT_STRENGTH = 0.8;
const UPLOAD_DEFAULT_STRENGTH = 0.65;

// Sidecarless turnaround candidate (crash between the PNG copy and the sidecar
// write) — module-scope so the candidate listing doesn't recompile it per file.
const TURNAROUND_CANDIDATE_RE = /^turnaround-candidate-\d+\.png$/;

// Manifests seeded from #2979 onward are turnaround-first: the sheet is the
// identity root, the main descends from it, and so does every anchor. A v1
// manifest was main-first (key frozen at main lock) and keeps that flow — it
// only has to backfill a sheet before deriving further anchors.
const TURNAROUND_FIRST_SCHEMA = 2;
const isTurnaroundFirst = (manifest) => (manifest?.schemaVersion || 1) >= TURNAROUND_FIRST_SCHEMA;

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

export async function loadManifest(recordId) {
  const manifest = await readJSONFile(join(spriteDir(recordId), manifestRelPath(recordId)), null);
  if (!manifest) return null;
  if (manifest.mainReference) {
    manifest.mainReference.path = rebaseLegacyPath(manifest.mainReference.path, recordId);
    manifest.mainReference.lockedFrom = rebaseLegacyPath(manifest.mainReference.lockedFrom, recordId);
  }
  if (manifest.turnaround) {
    manifest.turnaround.path = rebaseLegacyPath(manifest.turnaround.path, recordId);
    manifest.turnaround.lockedFrom = rebaseLegacyPath(manifest.turnaround.lockedFrom, recordId);
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
    schemaVersion: TURNAROUND_FIRST_SCHEMA,
    manifestId: `${recordId}-reference-set-v1`,
    status: 'needs-turnaround',
    characterFamily: recordId,
    projection: 'flat',
    rule: 'Every reference descends from the frozen turnaround sheet: the main reference is its front view, and every directional anchor is redrawn from the panel that shows that side. Locked artifacts are immutable evidence. Walk cycles are conditioned only on a locked directional anchor plus the deterministic pose scaffold, never on prior walk output, and the identity anchor is never regenerated.',
    chromaKey: null,
    turnaround: {
      path: null, role: 'identity-root', background: 'chroma-key', locked: false, views: TURNAROUND_VIEWS,
    },
    mainReference: { path: null, role: 'immutable-root', background: 'chroma-key', locked: false },
    anchors: SPRITE_DIRECTIONS.map((direction) => ({
      id: anchorIdForDirection(direction),
      kind: 'walk-anchor',
      direction,
      status: 'pending',
      source: direction === 'south' ? 'main-reference' : 'derive-from-turnaround',
    })),
    note: 'walk-south and walk-north double as the front/back idle stills, so no separate idle anchors are kept.',
  };
}

export async function requireCharacter(recordId) {
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

// Clip risk against BOTH keys a lock touches: the generation key (near-key
// details are already masked away) and, when different, the canvas key the
// artifact is composited onto (runtime keying on it would clip character
// pixels — e.g. green clothing locked onto a user-pinned green key).
function combinedClipWarning(palette, maskKeyHex, canvasKeyHex) {
  return [
    keyProximityWarning(palette, maskKeyHex),
    canvasKeyHex.toUpperCase() !== maskKeyHex.toUpperCase()
      ? keyProximityWarning(palette, canvasKeyHex, { role: 'selected' })
      : null,
  ].filter(Boolean).join(' — ') || null;
}

/**
 * Which key a lock composites onto, and whether this lock is the one choosing
 * it. Exactly one lock per character freezes the canonical key — the turnaround
 * lock on a turnaround-first record, the main lock on a legacy one — and every
 * lock after it inherits, so a later artifact can never fork the frozen set
 * onto a different background.
 *
 * `alreadyFrozen` is the caller's "a predecessor already locked" signal.
 * Returns `{ frozenKey, pinnedKey, auto, selectedKey }`; `frozenKey` non-null
 * means "inherited — do not touch the manifest's key fields."
 */
function resolveLockKey(manifest, record, palette, alreadyFrozen) {
  const frozenKey = alreadyFrozen ? (manifest.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY) : null;
  // Case-insensitive pin check: phase-1 accepted any-case hex, so an
  // upgraded record can hold '#00ff00' — that is still a pin, not auto.
  const pinnedKey = CHROMA_KEY_HEXES.find((k) => k === (record.chromaKey || '').toUpperCase()) || null;
  const auto = (frozenKey || pinnedKey) ? null : pickChromaKey(palette);
  return { frozenKey, pinnedKey, auto, selectedKey: frozenKey || pinnedKey || auto.hex };
}

/**
 * Record patch that is safe against a concurrent lock: a chromaKey change
 * must re-check the manifest INSIDE the per-record write tail, or a PATCH
 * racing `/reference/lock` could observe an unlocked manifest and then land
 * a pin that disagrees with the just-frozen canonical key (permanently,
 * since post-lock changes 409). Non-key patches pass straight through.
 */
export function patchSpriteRecord(recordId, patch) {
  if (!('chromaKey' in patch)) return updateRecord(recordId, patch);
  return manifestWriteTail(recordId, async () => {
    const manifest = await loadManifest(recordId);
    // Either lock can be the one that froze the canonical key: turnaround-first
    // records freeze it at turnaround lock, legacy ones at main lock.
    if (manifest?.mainReference?.locked || manifest?.turnaround?.locked) {
      throw new ServerError('Chroma key is frozen with the locked reference set', { status: 409, code: 'CHROMA_KEY_LOCKED' });
    }
    return updateRecord(recordId, patch);
  });
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
      // Sidecarless (crash between copy and sidecar write): infer the target
      // from the filename so the client can't group it under the wrong slot.
      const inferredDirection = /^walk-(.+)-candidate-\d+\.png$/.exec(name)?.[1] || null;
      const inferred = TURNAROUND_CANDIDATE_RE.test(name)
        ? TURNAROUND_ID
        : (inferredDirection === 'south' ? 'main' : inferredDirection);
      return {
        path: `reference/candidates/${name}`,
        target: sidecar?.target || inferred,
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
 * multipart parse — a design image seeding the identity root (the turnaround
 * sheet, or a legacy record's main), never an anchor. Copied into the record's
 * reference/uploads/ so provenance survives the temp-file sweep.
 */
export function startReferenceGeneration(recordId, body, upload = null) {
  return manifestWriteTail(recordId, () => startReferenceGenerationImpl(recordId, body, upload));
}

async function startReferenceGenerationImpl(recordId, body, upload = null) {
  const record = await requireCharacter(recordId);
  const manifest = (await loadManifest(recordId)) || seedManifest(recordId);
  const target = body.target;
  // Once either identity artifact is locked — the sheet on a turnaround-first
  // record, the main on a legacy one — the manifest's key is canonical (set at
  // that lock, possibly auto-selected); a later record-level repin must not
  // fork subsequent renders onto a different background than the frozen set.
  const genKey = manifest.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY;
  const settings = await getSettings();
  const mode = resolveQueueImageMode(body.mode, settings);

  let prompt;
  let initImagePath;
  let initImageStrength = Number.isFinite(body.initImageStrength) ? body.initImageStrength : undefined;
  let anchorId;
  let direction;
  let designReferencePath;
  let correctionPrompt;

  const turnaroundLocked = manifest.turnaround?.locked === true;
  const designPrompt = typeof body.designPrompt === 'string' ? body.designPrompt.trim() : '';
  // A render that establishes the character's look needs SOME input: a prompt,
  // an uploaded image, a gallery pick, or another sprite's reference to seed
  // from. `alsoSeeded` covers a source the branch supplies itself (the legacy
  // main a backfilled sheet expands, the sheet the main descends from).
  const requireDesignInput = (alsoSeeded = false) => {
    if (designPrompt || alsoSeeded || upload || body.initImageGalleryFile || body.initImageSpriteId) return;
    throw new ServerError('Provide a design prompt and/or a reference image', { status: 400, code: 'DESIGN_INPUT_REQUIRED' });
  };

  if (target === TURNAROUND_ID) {
    if (turnaroundLocked) {
      throw new ServerError('Turnaround sheet is locked — corrections require a new character version, never regeneration', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    requireDesignInput(manifest.mainReference.locked);
    anchorId = TURNAROUND_ID;
    prompt = buildTurnaroundPrompt({
      name: record.name,
      designPrompt: designPrompt || manifest.designPrompt,
      chromaKey: genKey,
    });
    ({ initImagePath, designReferencePath } = await resolveSeedSource(recordId, body, upload));
    // Legacy backfill: no explicit seed, but a frozen main exists — expand the
    // one view we already have into the full sheet rather than inventing a new
    // character from text.
    if (!initImagePath && manifest.mainReference.locked) {
      initImagePath = await requireLockedArtifactPath(recordId, manifest.mainReference.path, {
        message: 'Locked main reference file is missing on disk', code: 'MAIN_REFERENCE_MISSING',
      });
      designReferencePath = manifest.mainReference.path;
    }
    if (initImagePath) initImageStrength ??= UPLOAD_DEFAULT_STRENGTH;
    if (designPrompt) manifest.designPrompt = designPrompt;
    // The sheet is the first render, so this save may be persisting a manifest
    // that was only just seeded — it runs unconditionally. The later branches
    // require locked predecessors, so their manifest is already on disk and
    // only needs writing back when the design prompt actually changed.
    await saveManifest(recordId, manifest);
  } else if (target === 'main') {
    if (manifest.mainReference.locked) {
      throw new ServerError('Main reference is locked — corrections require a new character version, never regeneration', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    // Turnaround-first (#2979): on a manifest seeded under the new standard the
    // main is the sheet's front view, so the sheet must exist first. A legacy
    // v1 manifest predates the sheet and keeps its main-first flow — it only
    // has to backfill a sheet before deriving further anchors.
    if (!turnaroundLocked && isTurnaroundFirst(manifest)) {
      throw new ServerError('Lock the turnaround sheet before deriving the main reference', { status: 409, code: 'TURNAROUND_NOT_LOCKED' });
    }
    anchorId = anchorIdForDirection('south');
    direction = 'south';
    prompt = buildMainReferencePrompt({
      name: record.name,
      designPrompt: designPrompt || manifest.designPrompt,
      chromaKey: genKey,
      fromTurnaround: turnaroundLocked,
    });
    if (turnaroundLocked) {
      initImagePath = await requireLockedTurnaroundPath(recordId, manifest);
      initImageStrength ??= ANCHOR_DEFAULT_STRENGTH;
    } else {
      // Legacy v1 main, still on the main-first flow: a prompt, an uploaded
      // image, a gallery pick, or another sprite's reference is required.
      requireDesignInput();
      ({ initImagePath, designReferencePath } = await resolveSeedSource(recordId, body, upload));
      if (initImagePath) initImageStrength ??= UPLOAD_DEFAULT_STRENGTH;
    }
    // Nothing else in this branch mutates the manifest, so skip the write —
    // and its per-record serialization — on the common no-prompt re-roll.
    if (designPrompt) {
      manifest.designPrompt = designPrompt;
      await saveManifest(recordId, manifest);
    }
  } else {
    if (!ANCHOR_DIRECTIONS.includes(target)) {
      throw new ServerError(`Unknown reference target: ${target}`, { status: 400, code: 'INVALID_TARGET' });
    }
    // The whole point of the sheet: an anchor drawn from a single front view
    // has to invent the side it is facing, which is how a hip bag ends up on
    // the character's back. Required on every record — a legacy one backfills.
    if (!turnaroundLocked) {
      throw new ServerError('Lock the turnaround sheet before deriving directional anchors', { status: 409, code: 'TURNAROUND_NOT_LOCKED' });
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
    // Optional user correction re-appended on every re-roll — diverges the
    // render from the previous candidate rather than reproducing its mistakes.
    correctionPrompt = typeof body.correctionPrompt === 'string' ? body.correctionPrompt.trim() : '';
    prompt = buildAnchorPrompt({
      name: record.name, direction, chromaKey: genKey, correctionPrompt, fromTurnaround: true,
    });
    initImagePath = await requireLockedTurnaroundPath(recordId, manifest);
    initImageStrength ??= ANCHOR_DEFAULT_STRENGTH;
    // Known limitation shared with every i2i surface (proof-as-base, refine):
    // the WINDOWS local runner (imagine_win.py) has no i2i and drops the
    // init image — anchors there degrade to text-to-image, like all other
    // pipeline i2i renders on that platform. Cloud modes are unaffected.
  }

  const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
  const codexModel = body.model || settings.imageGen?.codex?.model || CODEX_IMAGEGEN_DEFAULT_MODEL;
  // The model the provider will ACTUALLY run, for candidate provenance —
  // grok picks its model internally, so its sidecars record null.
  const effectiveModel = mode === IMAGE_GEN_MODE.CODEX
    ? codexModel
    : mode === IMAGE_GEN_MODE.LOCAL
      ? (body.model || settings.imageGen?.local?.modelId || LOCAL_IMAGEGEN_DEFAULT_MODEL)
      : null;
  const baseParams = {
    prompt,
    ...(initImagePath ? { initImagePath, initImageStrength } : {}),
    cleanC2PA,
    denoise,
    // Destination tag the completion hook files the render by.
    spriteRef: {
      recordId, target, direction, anchorId, chromaKey: genKey, mode, model: effectiveModel,
      ...((target === TURNAROUND_ID || target === 'main') && body.designPrompt ? { designPrompt: body.designPrompt } : {}),
      ...(correctionPrompt ? { correctionPrompt } : {}),
      ...(designReferencePath ? { designReferencePath } : {}),
    },
  };
  const params = mode === IMAGE_GEN_MODE.CODEX
    ? { mode, codexPath: settings.imageGen?.codex?.codexPath, model: codexModel, effort: body.effort || settings.imageGen?.codex?.effort, ...baseParams }
    : mode === IMAGE_GEN_MODE.GROK
      ? { mode, grokPath: settings.imageGen?.grok?.grokPath, aspectRatio: settings.imageGen?.grok?.aspectRatio, ...baseParams }
      // Thread the resolved model (request override → saved local model) —
      // the queue dispatches straight to local.generateImage, which does NOT
      // read settings and would otherwise fall back to its own default.
      : { mode, pythonPath: settings.imageGen?.local?.pythonPath || null, ...(effectiveModel ? { modelId: effectiveModel } : {}), ...baseParams };

  const { jobId } = enqueueJob({ kind: 'image', params, owner: 'sprites' });
  console.log(`🧍 sprite reference render queued ${recordId}/${anchorId} mode=${mode} jobId=${jobId.slice(0, 8)}`);
  return { jobId, mode, target, anchorId };
}

/**
 * A locked artifact's record-relative path resolved to an on-disk init image.
 * Every render that descends from a locked reference routes through here so a
 * manifest claiming a lock whose file vanished fails loudly instead of silently
 * degrading to text-to-image (which would reintroduce the invented-sides bug).
 */
async function requireLockedArtifactPath(recordId, relPath, { message, code }) {
  const abs = resolveSpriteAssetPath(recordId, relPath);
  if (!await pathExists(abs)) throw new ServerError(message, { status: 500, code });
  return abs;
}

const requireLockedTurnaroundPath = (recordId, manifest) => requireLockedArtifactPath(
  recordId, manifest.turnaround.path,
  { message: 'Locked turnaround sheet file is missing on disk', code: 'TURNAROUND_MISSING' },
);

/**
 * The locked artifact a derive should seed from: the turnaround sheet when the
 * record has one (all sides, so accessory placement carries over), else the
 * locked main. One definition so the "select a reference sprite" picker can
 * never advertise a different image than the render actually attaches.
 */
const lockedSeedArtifact = (manifest) => (
  [manifest?.turnaround, manifest?.mainReference].find((a) => a?.locked && a.path) || null
);

/**
 * Resolve the optional i2i seed image from exactly one source — an upload wins,
 * then a render-history gallery pick, then another sprite's locked reference.
 * Returns `{ initImagePath, designReferencePath }` (both undefined when the
 * caller supplied no seed); `designReferencePath` is the provenance marker that
 * rides the tag into the candidate sidecar.
 */
async function resolveSeedSource(recordId, body, upload) {
  if (upload) {
    // Shared temp-import (uuid-prefixed name, EXDEV-safe copy+unlink) — the
    // upload persists in the record dir as design provenance so a locked
    // candidate stays traceable to the upload that guided it.
    const uploadsDir = join(spriteDir(recordId), 'reference', 'uploads');
    const { filename } = await importFileToDir(upload.tempPath, upload.originalname || 'design-reference.png', uploadsDir);
    return { initImagePath: join(uploadsDir, filename), designReferencePath: `reference/uploads/${filename}` };
  }
  if (body.initImageGalleryFile) {
    const resolved = resolveGalleryImage(body.initImageGalleryFile);
    if (!resolved) {
      throw new ServerError('Reference image not found in the render-history gallery', { status: 400, code: 'INIT_IMAGE_NOT_FOUND' });
    }
    return { initImagePath: resolved, designReferencePath: `gallery:${body.initImageGalleryFile}` };
  }
  if (body.initImageSpriteId) {
    const source = await resolveSourceReference(body.initImageSpriteId);
    return {
      initImagePath: source.absPath,
      designReferencePath: `sprite:${body.initImageSpriteId}/${source.relPath}`,
    };
  }
  return {};
}

/**
 * Resolve a source sprite's best locked reference to an on-disk init image —
 * its turnaround sheet when it has one (all sides, so a fork inherits accessory
 * placement), else its locked main. Throws (400/500) rather than silently
 * degrading to text-to-image so the caller learns the fork/derive source is
 * unusable up front.
 */
async function resolveSourceReference(sourceId) {
  // loadManifest, not getReferenceSet — we only need the locked artifacts, and
  // the latter also enumerates + reads every candidate sidecar (wasted here).
  const best = lockedSeedArtifact(await loadManifest(sourceId));
  if (!best) {
    throw new ServerError('The source sprite has no locked reference to seed from', { status: 400, code: 'SOURCE_REFERENCE_MISSING' });
  }
  const absPath = await requireLockedArtifactPath(sourceId, best.path, {
    message: 'The source sprite reference file is missing on disk', code: 'SOURCE_REFERENCE_FILE_MISSING',
  });
  return { absPath, relPath: best.path };
}

/**
 * List every character with a locked reference to seed from — the pool behind
 * the "select an existing reference sprite" picker and the fork flow. `path` is
 * what a seed actually attaches (the turnaround sheet when there is one, per
 * resolveSourceReference); `turnaroundPath` is non-null when that pick carries
 * all sides, so the client can say so.
 * Reads each character's manifest (loadManifest, not getReferenceSet — the
 * candidate enumeration the latter does is wasted here), so it's a per-request
 * O(characters) scan; fine for a user-triggered modal fetch, revisit if the
 * library grows huge.
 */
export async function listReferenceSources() {
  const records = await listRecords();
  const out = [];
  for (const r of records) {
    if (r.kind !== 'character' || r.deleted) continue;
    const manifest = await loadManifest(r.id);
    // Same picker resolveSourceReference uses, so the advertised image is
    // exactly the one a seed will attach.
    const seed = lockedSeedArtifact(manifest);
    if (seed) {
      const turnaround = manifest?.turnaround?.locked ? manifest.turnaround.path : null;
      out.push({
        id: r.id, name: r.name, kind: r.kind, path: seed.path, turnaroundPath: turnaround,
      });
    }
  }
  return out;
}

// Browser-renderable image formats (mirrors the client's spriteAssets probe
// list — sharp can read more than a browser can paint, so a TIFF is skipped).
const THUMBNAIL_RENDERABLE = /^(png|gif|webp|jpeg|jpg|svg)$/;

/**
 * A representative Library-catalog thumbnail for EVERY record, not just
 * reference-workflow characters. A character with a locked main uses that (its
 * canonical face, one manifest read); every other kind — places, objects,
 * imported prop atlases, and a character with no locked main yet — falls back
 * to its first previewable on-disk image (listSpriteAssets already sorts by
 * path, so it's deterministic). Returns `[{ id, path }]` (record-relative),
 * omitting records with no usable image. O(records): a locked character costs
 * one manifest read, everything else one asset-dir scan — a catalog-view fetch,
 * not a hot path (the client only calls it on the `/sprites` Library view).
 */
export async function listSpriteThumbnails() {
  const records = await listRecords();
  const results = await Promise.all(records.map(async (r) => {
    if (r.deleted) return null;
    if (r.kind === 'character') {
      const manifest = await loadManifest(r.id);
      const main = manifest?.mainReference;
      if (main?.locked && main.path) return { id: r.id, path: main.path };
    }
    const assets = await listSpriteAssets(r.id);
    const preview = assets.find((a) => a.width && a.height && THUMBNAIL_RENDERABLE.test(a.format || ''));
    return preview ? { id: r.id, path: preview.path } : null;
  }));
  return results.filter(Boolean);
}

/**
 * Fork a new character from an existing sprite's locked reference: create the
 * record, then image+text→image its TURNAROUND from the source reference via
 * the shared generate path (`initImageSpriteId`) — the fork enters the same
 * turnaround-first workflow every new character does. Validates the source
 * BEFORE creating the record so a bad fork never leaves an orphan character
 * behind. User-triggered only.
 */
export async function forkSprite(sourceId, body) {
  await resolveSourceReference(sourceId); // fail fast before creating a record
  const record = await createCharacter({ name: body.name, id: body.id, kind: 'character' });
  const gen = await startReferenceGeneration(record.id, {
    target: TURNAROUND_ID,
    designPrompt: body.designPrompt,
    initImageSpriteId: sourceId,
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.effort ? { effort: body.effort } : {}),
    ...(Number.isFinite(body.initImageStrength) ? { initImageStrength: body.initImageStrength } : {}),
  });
  console.log(`🧬 sprite fork ${sourceId} → ${record.id} jobId=${gen.jobId.slice(0, 8)}`);
  return { record, ...gen };
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
    // Prefer the completed job's live params — Render Queue's Edit & Retry
    // rewrites top-level params but carries the original tag through, so the
    // tag's model can be stale provenance.
    model: ctx.job?.params?.model || ctx.job?.params?.modelId || ctx.model || null,
    // The literal prompt sent to the provider — the completed job's live params
    // are canonical (Render Queue's Edit & Retry can rewrite it). Persisting it
    // lets the preview modals show exactly what was rendered; older sidecars
    // without it fall back to a deterministic rebuild (services/sprites/assetPrompt.js).
    prompt: ctx.job?.params?.prompt || null,
    jobId: ctx.jobId || null,
    ...(ctx.designPrompt ? { designPrompt: ctx.designPrompt } : {}),
    ...(ctx.correctionPrompt ? { correctionPrompt: ctx.correctionPrompt } : {}),
    ...(ctx.designReferencePath ? { designReferencePath: ctx.designReferencePath } : {}),
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

async function lockReferenceImpl(recordId, { target, candidate, acceptClipRisk = false }) {
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
  // misclick would freeze the wrong pose as immutable evidence. The filename
  // prefix is checked as well as the sidecar: a crash between the PNG copy
  // and the sidecar write leaves a sidecarless candidate whose target would
  // otherwise be unverifiable.
  if (sidecar?.target && sidecar.target !== target) {
    throw new ServerError(`Candidate was generated for target "${sidecar.target}", not "${target}"`, { status: 400, code: 'CANDIDATE_TARGET_MISMATCH' });
  }
  const expectedPrefix = target === TURNAROUND_ID
    ? `${TURNAROUND_ID}-candidate-`
    : `${anchorIdForDirection(target === 'main' ? 'south' : target)}-candidate-`;
  if (!candidate.slice('reference/candidates/'.length).startsWith(expectedPrefix)) {
    throw new ServerError(`Candidate filename does not match target "${target}" (expected ${expectedPrefix}*)`, { status: 400, code: 'CANDIDATE_TARGET_MISMATCH' });
  }
  // Mask on the key the candidate was GENERATED against (its actual
  // background), which may differ from the key selected at lock time.
  const maskKey = sidecar?.chromaKey || record.chromaKey || DEFAULT_CHROMA_KEY;
  const now = new Date().toISOString();

  if (target === TURNAROUND_ID) {
    if (manifest.turnaround?.locked) {
      throw new ServerError('Turnaround sheet is already locked', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    const analysis = await analyzeForeground(candAbs, maskKey);
    const palette = paletteFromAnalysis(analysis);
    // Turnaround-first records choose the canonical key HERE, off a holistic
    // palette: a key-colored item only visible from behind is counted up front
    // instead of surfacing as a surprise clip 409 at anchor-lock time. A legacy
    // record froze its key at main lock — inherit it, never reselect.
    const { frozenKey, pinnedKey, auto, selectedKey } = resolveLockKey(manifest, record, palette, manifest.mainReference.locked);
    const clipWarning = combinedClipWarning(palette, maskKey, selectedKey);
    if (clipWarning && !acceptClipRisk) {
      throw new ServerError(`${clipWarning}. Re-send with acceptClipRisk to lock anyway.`, { status: 409, code: 'CHROMA_CLIP_RISK' });
    }
    const rel = `reference/${await nextVersionPath(refDir, `${recordId}-${TURNAROUND_ID}`)}`;
    const destAbs = join(spriteDir(recordId), rel);
    // Re-key, don't reframe: the single-figure geometry normalizeFromAnalysis
    // applies is meaningless for a multi-figure sheet, but the sheet is the
    // init image for every later render whose prompt names the canonical key.
    await recompositeOnKey(analysis, candAbs, destAbs, selectedKey);
    const sha256 = await sha256File(destAbs);
    if (!frozenKey) {
      manifest.chromaKey = selectedKey;
      manifest.chromaKeyAutoSelected = !pinnedKey;
      manifest.chromaKeyWarning = [auto?.warning, clipWarning].filter(Boolean).join(' — ') || null;
    }
    manifest.turnaround = {
      ...(manifest.turnaround || {}),
      path: rel,
      role: 'identity-root',
      background: 'chroma-key',
      views: manifest.turnaround?.views || TURNAROUND_VIEWS,
      locked: true,
      lockedFrom: candidate,
      lockedAt: now,
      sha256,
      ...(frozenKey && clipWarning ? { clipWarning } : {}),
    };
    if (!manifest.mainReference.locked) manifest.status = 'needs-main-reference';
    // Record BEFORE manifest, same rationale as the main lock below. A legacy
    // backfill inherits an already-frozen key and an already-set record status,
    // so it touches the record not at all.
    if (!frozenKey) await updateRecord(recordId, { chromaKey: selectedKey, status: 'reference' });
    await saveManifest(recordId, manifest);
  } else if (target === 'main') {
    if (manifest.mainReference.locked) {
      throw new ServerError('Main reference is already locked', { status: 409, code: 'REFERENCE_LOCKED' });
    }
    // Dynamic key selection (#2895): histogram the character's own palette
    // and pick the standard key farthest from it in hue — unless the user
    // already pinned a key on the record, or the turnaround lock already froze
    // one (#2979). One analyzeForeground decode feeds the palette and the
    // composite; the palette is computed even when pinned/frozen because the
    // clip warning below needs it.
    const analysis = await analyzeForeground(candAbs, maskKey);
    const palette = paletteFromAnalysis(analysis);
    const { frozenKey, pinnedKey, auto, selectedKey } = resolveLockKey(manifest, record, palette, manifest.turnaround?.locked);
    // Selection only sees pixels that SURVIVED the generation-key mask —
    // exact-key details (magenta garment on the magenta default) are already
    // gone from the palette — and a pinned key can collide with the palette
    // that DID survive. Surface both risks instead of silently locking a
    // clipped identity root.
    const clipWarning = combinedClipWarning(palette, maskKey, selectedKey);
    // A clip-risk lock is irreversible (the frozen root may already be
    // missing exact-key details) — refuse unless the caller explicitly
    // accepts, so the user learns BEFORE the 409 wall goes up, not after.
    if (clipWarning && !acceptClipRisk) {
      throw new ServerError(`${clipWarning}. Re-send with acceptClipRisk to lock anyway.`, { status: 409, code: 'CHROMA_CLIP_RISK' });
    }
    const rel = `reference/${await nextVersionPath(refDir, `${recordId}-walk-south`)}`;
    const destAbs = join(spriteDir(recordId), rel);
    await normalizeFromAnalysis(analysis, candAbs, destAbs, selectedKey);
    const sha256 = await sha256File(destAbs);
    if (!frozenKey) {
      manifest.chromaKey = selectedKey;
      manifest.chromaKeyAutoSelected = !pinnedKey;
      manifest.chromaKeyWarning = [auto?.warning, clipWarning].filter(Boolean).join(' — ') || null;
    }
    manifest.mainReference = {
      ...manifest.mainReference,
      path: rel,
      background: 'chroma-key',
      locked: true,
      lockedFrom: candidate,
      lockedAt: now,
      sha256,
      ...(frozenKey && clipWarning ? { clipWarning } : {}),
    };
    const south = findAnchor(manifest, anchorIdForDirection('south'));
    if (south) Object.assign(south, { status: 'locked', path: rel, lockedFrom: candidate, sha256 });
    manifest.status = 'in-progress';
    // Record BEFORE manifest: a crash between the two leaves the record
    // updated but the manifest unlocked — recoverable by re-locking. The
    // reverse order would wedge (locked manifest + stale record, with both
    // relock and key PATCH returning 409 forever). Skipped entirely when the
    // turnaround lock already froze the key and set the status.
    if (!frozenKey) await updateRecord(recordId, { chromaKey: selectedKey, status: 'reference' });
    await saveManifest(recordId, manifest);
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
    // A direction can reveal key-colored detail the front view never showed
    // (a green backpack on a green key) — anchors get the same clip gate as
    // the main.
    const analysis = await analyzeForeground(candAbs, maskKey);
    const clipWarning = combinedClipWarning(paletteFromAnalysis(analysis), maskKey, canvasKey);
    if (clipWarning && !acceptClipRisk) {
      throw new ServerError(`${clipWarning}. Re-send with acceptClipRisk to lock anyway.`, { status: 409, code: 'CHROMA_CLIP_RISK' });
    }
    const rel = `reference/${await nextVersionPath(refDir, `${recordId}-${anchorId}`)}`;
    const destAbs = join(spriteDir(recordId), rel);
    await normalizeFromAnalysis(analysis, candAbs, destAbs, canvasKey);
    Object.assign(anchor, {
      status: 'locked', path: rel, lockedFrom: candidate, lockedAt: now, sha256: await sha256File(destAbs),
      ...(clipWarning ? { clipWarning } : {}),
    });
    const allLocked = manifest.anchors.every((a) => a.status === 'locked');
    if (allLocked) manifest.status = 'complete';
    await saveManifest(recordId, manifest);
    if (allLocked) await updateRecord(recordId, { status: 'reference-complete' });
  }
  console.log(`🔒 sprite reference locked ${recordId}/${target} from ${candidate}`);
  return getReferenceSet(recordId);
}
