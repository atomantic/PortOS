/**
 * Sprites — production-asset importer (issue #2895, phase 1).
 *
 * Ingests the approved/final artifacts of an ElsewhereAcres-layout sprite
 * pipeline into data/sprites/, creating/refreshing a sprite record per
 * subject. Expected source layout (all paths relative to `sourceRoot`):
 *
 *   art-pipeline/characters/<id>.json            character specs
 *   art-source/sprites/<id>/reference/           locked main + anchors (+ candidates/, skipped)
 *   art-source/sprites/<id>/walk/                finalized walk-set manifests
 *   art-source/sprites/<id>/grok|runs/<run-id>/  animation runs (only files the walk set references)
 *   art-source/sprites/<id>/runtime/vN/          immutable published atlas archives
 *   art-source/sprites/<id>/imagegen/vN/         approved redraw sources
 *   art-pipeline/catalog/runtime-selection.json  current published-atlas pointer
 *   game/assets/sprites/<family>/                props atlas families (PNG + README)
 *
 * Only approved/final artifacts import: reference candidates and extracted
 * frame intermediates stay behind. A run's `generated/source-video.mp4` DOES
 * import (#2984) — with authorable frame counts (#2970) it is the input to
 * re-deriving a walk cycle, not a spent intermediate.
 *
 * Where a source manifest carries a
 * sha256 for a file, the copied bytes are verified against it — a mismatch is
 * recorded per-item (the import continues) so one corrupt file can't abort a
 * whole tree. Runs on demand only (a user action) — never at boot.
 */

import { join, basename, dirname } from 'path';
import { readdir, copyFile, rm } from 'fs/promises';
import { PATHS, ensureDir, sha256File, atomicWrite, pathExists, readJSONFile, expandHome } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { upsertImportedRecord } from './records.js';
import { spriteDir, RUN_DIR_MATCH } from './paths.js';
import { isValidSpriteId } from './recordsLogic.js';

// The source pipeline keys everything on magenta; imported characters carry it
// so later re-renders stay consistent with their existing anchors/strips.
const LEGACY_CHROMA_KEY = '#FF00FF';

const PROP_FILE_EXTENSIONS = ['.png', '.md'];

// Absent-or-corrupt manifest reads collapse to null — the importer treats both
// as "nothing to import from this manifest."
const readJson = (p) => readJSONFile(p, null, { logError: false });

/**
 * Recursively copy `srcDir` into `destDir`, filtering by `shouldCopy(relPath,
 * isDir)`. Returns the list of copied file paths relative to destDir.
 */
async function copyTree(srcDir, destDir, shouldCopy = () => true) {
  const copied = [];
  const ensuredDirs = new Set();
  async function walk(current, rel) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!shouldCopy(entryRel, entry.isDirectory())) continue;
      const srcPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(srcPath, entryRel);
      } else if (entry.isFile()) {
        const destPath = join(destDir, entryRel);
        const parent = dirname(destPath);
        if (!ensuredDirs.has(parent)) {
          await ensureDir(parent);
          ensuredDirs.add(parent);
        }
        await copyFile(srcPath, destPath);
        copied.push(entryRel);
      }
    }
  }
  await walk(srcDir, '');
  return copied;
}

/**
 * Verify hash-pinned files against the sha256s the source manifests declare.
 * Only files copied by THIS run count — a stale copy left in the destination
 * by an earlier import must not vouch for a file the current source no
 * longer provides. Duplicate expectations (the same file pinned by more than
 * one manifest) collapse to one check per (path, hash).
 */
async function verifyHashes(destDir, expectations, errors, copiedThisRun) {
  const seen = new Set();
  const unique = expectations.filter(({ relPath, sha256 }) => {
    if (typeof sha256 !== 'string' || !sha256) return false;
    const key = `${relPath}\n${sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const outcomes = await Promise.all(
    unique.map(async ({ relPath, sha256 }) => {
      if (!copiedThisRun.has(relPath)) return { error: `missing from source: ${relPath}` };
      if ((await sha256File(join(destDir, relPath))) === sha256) return { verified: true };
      // A still that fails its pin stays on disk with an error recorded — the
      // record is still browsable and the mismatch is visible. A source CLIP
      // is different: it is the INPUT to re-deriving a cycle (#2984), so bytes
      // the manifest disowns would let a later re-derive silently emit frames
      // nobody approved. Drop it — that run just stays non-re-derivable until
      // a clean re-import.
      if (SOURCE_CLIP_REF.test(relPath)) {
        await rm(join(destDir, relPath), { force: true });
        return { error: `run ${relPath.split('/')[1]}: source clip failed sha256 verification — not imported` };
      }
      return { error: `sha256 mismatch: ${relPath}` };
    }),
  );
  for (const o of outcomes) if (o.error) errors.push(o.error);
  return outcomes.filter((o) => o.verified).length;
}

// Manifest paths reference files repo-relative (art-source/sprites/<id>/…) or
// occasionally bare. Normalize to a path relative to the character's source
// dir so it can be re-anchored under data/sprites/<id>/. Manifest content is
// request-influenced data feeding join() as a WRITE destination, so a `..`
// segment (or empty segment) rejects the whole path — a corrupt/crafted
// manifest must not be able to copy outside data/sprites/.
function relToCharacterDir(manifestPath, characterId) {
  if (typeof manifestPath !== 'string' || !manifestPath) return null;
  // Anchor to the SOURCE tree — a published game-tree path
  // (game/assets/sprites/<id>/…) or engine resource URI also contains
  // "sprites/<id>/" but is not a character-dir asset.
  const marker = `art-source/sprites/${characterId}/`;
  const idx = manifestPath.indexOf(marker);
  const rel = idx >= 0 ? manifestPath.slice(idx + marker.length) : manifestPath.replace(/^\/+/, '');
  // A repo-anchored path OUTSIDE the character dir (contract docs, pipeline
  // catalogs) is provenance, not a character asset — don't misread it as
  // character-relative and then report it "missing".
  if (idx < 0 && /^(art-pipeline|art-source|game)\//.test(rel)) return null;
  // Split on BOTH separators — on Windows a `..\` segment would otherwise ride
  // through the check as one opaque segment and still traverse in join().
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return null;
  return rel;
}

// Asset references worth importing from a run's manifests: images, previews,
// and packaged manifests — never raw/extracted intermediates.
const ASSET_REF = /\.(png|gif|json)$/i;
// A run's i2v source clip — the ONE video that imports (#2984). Frame counts
// became authorable in #2970 and the packer only ever resamples DOWN, so
// without the clip an imported direction is permanently stuck at whatever
// frame count it arrived with: re-deriving it needs the clip re-extracted.
// Matched by exact shape rather than a blanket `.mp4` rule so unrelated videos
// in the source tree still stay behind. `raw/` frames deliberately remain
// excluded below — ~5× the bytes of the clip they were extracted from, and
// re-derivation re-extracts them on demand.
const SOURCE_CLIP_NAME = 'source-video.mp4';
const SOURCE_CLIP_REF = new RegExp(`${RUN_DIR_MATCH.source}/generated/${SOURCE_CLIP_NAME.replace(/\./g, '\\.')}$`);
const EXCLUDED_RUN_SEGMENTS = /(^|\/)(raw|frames|review)\//;
// Free-text log fields in run records can contain path-looking strings that
// were never assets — don't traverse them.
const NOISE_KEYS = /tail$|^stdout|^stderr|^log$/i;

function importableRel(value, characterId) {
  const rel = relToCharacterDir(value, characterId);
  if (!rel || EXCLUDED_RUN_SEGMENTS.test(rel)) return null;
  return ASSET_REF.test(rel) || SOURCE_CLIP_REF.test(rel) ? rel : null;
}

// Source-tree layout drift: a run's files can sit under `grok/<run-id>/` while
// the manifests naming them say `runs/<run-id>/` (or the reverse) — the two
// trees are the same run under two prefixes, which is exactly the dual-root
// tolerance `getWalkState` already applies on read (walk.js RUN_SCAN_DIRS).
// Returns the twin path under the other run-dir prefix, or null for a path
// that isn't inside a run dir at all.
function altRunLayoutRel(rel) {
  const match = /^(grok|runs)(\/.+)$/.exec(rel);
  return match ? `${match[1] === 'grok' ? 'runs' : 'grok'}${match[2]}` : null;
}

/**
 * Recursively collect importable asset paths referenced anywhere in a
 * manifest's JSON — and, when a manifest hash-pins a referenced file (a
 * `{ path, sha256 }` record, or the `<base>Path`/`<base>Sha256` sibling-key
 * convention), the expectation pair so the copied bytes get verified too.
 */
function collectManifestRefs(node, characterId, refs, expectations) {
  if (typeof node === 'string') {
    const rel = importableRel(node, characterId);
    if (rel) refs.add(rel);
  } else if (Array.isArray(node)) {
    for (const v of node) collectManifestRefs(v, characterId, refs, expectations);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (NOISE_KEYS.test(k)) continue;
      collectManifestRefs(v, characterId, refs, expectations);
    }
    if (typeof node.sha256 === 'string' && typeof node.path === 'string') {
      const rel = importableRel(node.path, characterId);
      if (rel) expectations.push({ relPath: rel, sha256: node.sha256 });
    }
    for (const [k, v] of Object.entries(node)) {
      if (!k.endsWith('Sha256') || typeof v !== 'string') continue;
      const base = k.slice(0, -'Sha256'.length);
      const pathVal = node[base] ?? node[`${base}Path`];
      if (typeof pathVal !== 'string') continue;
      const rel = importableRel(pathVal, characterId);
      if (rel) expectations.push({ relPath: rel, sha256: v });
    }
  }
}

// Resolve a declared path against the SOURCE tree, tolerating run-layout
// drift: returns whichever path actually exists (the declared one, or its twin
// under the other run-dir prefix), or null when neither does.
async function resolveSourceRel(srcCharDir, rel) {
  if (await pathExists(join(srcCharDir, rel))) return rel;
  const alt = altRunLayoutRel(rel);
  return alt && (await pathExists(join(srcCharDir, alt))) ? alt : null;
}

// Read a character-dir JSON through the same drift tolerance, so a manifest
// naming `runs/<run-id>/…` still expands when the source stores that run under
// `grok/<run-id>/`. Absent/corrupt → null, like every other manifest read here.
async function readCharJson(srcCharDir, rel) {
  const srcRel = await resolveSourceRel(srcCharDir, rel);
  return srcRel ? readJson(join(srcCharDir, srcRel)) : null;
}

// Copy one character-dir file, always landing it at the DECLARED path: the
// manifests that name it are copied byte-for-byte (their hashes are pinned),
// so readers re-anchor those same declared paths — putting the bytes anywhere
// else would import a file nothing can find. Only the source lookup tolerates
// drift.
async function copyCharFile(srcCharDir, destDir, rel) {
  const srcRel = await resolveSourceRel(srcCharDir, rel);
  if (!srcRel) return false;
  const dest = join(destDir, rel);
  await ensureDir(dirname(dest));
  await copyFile(join(srcCharDir, srcRel), dest);
  return true;
}

/**
 * Import one APPROVED direction of a finalized walk set: the run manifest
 * (hash-verified), then only the assets the run's manifests declare — packed
 * strips, packaged manifests, previews, and the run's source clip. Works for
 * both grok runs (record at
 * run root, assets under generated/) and imagegen redraw runs (manifest +
 * strips at the version root, surrounded by unselected candidates that must
 * stay behind).
 */
async function importApprovedDirection({ srcCharDir, destDir, characterId, direction, dir, result, hashExpectations, copiedThisRun }) {
  const manifestRel = relToCharacterDir(dir.runManifest, characterId);
  if (!manifestRel) {
    result.errors.push(`walk set ${direction}: unsafe run path rejected: ${dir.runManifest || dir.runPath}`);
    return;
  }
  if (!(await copyCharFile(srcCharDir, destDir, manifestRel))) {
    result.errors.push(`walk set ${direction}: run manifest missing: ${manifestRel}`);
    return;
  }
  result.files += 1;
  copiedThisRun.add(manifestRel);
  if (dir.runManifestSha256) hashExpectations.push({ relPath: manifestRel, sha256: dir.runManifestSha256 });

  const refs = new Set();
  collectManifestRefs(await readCharJson(srcCharDir, manifestRel), characterId, refs, hashExpectations);
  const runRel = relToCharacterDir(dir.runPath, characterId);
  if (runRel && (await resolveSourceRel(srcCharDir, `${runRel}/generated/review-preview.json`))) {
    refs.add(`${runRel}/generated/review-preview.json`);
  }
  // The source clip (#2984). Most packaged manifests name it (so the generic
  // collector already has it, hash pin included), but an older imported
  // manifest may not — and a direction with no clip can never be re-derived at
  // a different frame count. Probe the run dir under both layouts, keeping the
  // ENTRY's layout as the reference so the clip lands beside the rest of this
  // run's files.
  const clipRel = runRel ? `${runRel}/generated/${SOURCE_CLIP_NAME}` : null;
  // SOURCE_CLIP_REF re-gates the probe so this stays the same narrow rule the
  // manifest collector applies — an imagegen redraw entry (no run dir) never
  // acquires a clip through the back door.
  if (clipRel && SOURCE_CLIP_REF.test(clipRel) && !refs.has(clipRel) && (await resolveSourceRel(srcCharDir, clipRel))) {
    refs.add(clipRel);
  }
  // One extra expansion level: packaged manifests / previews the run record
  // names in turn declare the strip files (and their hash pins).
  for (const rel of [...refs]) {
    if (rel.endsWith('.json')) collectManifestRefs(await readCharJson(srcCharDir, rel), characterId, refs, hashExpectations);
  }
  refs.delete(manifestRel);
  for (const rel of [...refs].sort()) {
    if (await copyCharFile(srcCharDir, destDir, rel)) {
      result.files += 1;
      copiedThisRun.add(rel);
    } else {
      // A manifest-declared asset the source no longer has is a real gap —
      // an "imported" subject must not silently omit an approved artifact.
      result.errors.push(`walk set ${direction}: referenced asset missing: ${rel}`);
    }
  }
}

async function importCharacter({ sourceRoot, characterId, spec, specPath, selection }) {
  const result = { id: characterId, kind: 'character', files: 0, verified: 0, errors: [] };
  const srcCharDir = join(sourceRoot, 'art-source', 'sprites', characterId);
  const destDir = spriteDir(characterId);

  // A destination with a LOCKED reference set (#2896) is immutable evidence
  // — a same-id import would copy the source's reference tree straight over
  // the frozen identity root, bypassing every lock check. Refuse the whole
  // character; the user can delete the record or import under another id.
  const destManifest = await readJSONFile(join(destDir, 'reference', `${characterId}-reference-set-v1.json`), null);
  if (destManifest?.mainReference?.locked) {
    result.errors.push('destination has a locked reference set — refusing to overwrite immutable artifacts (delete the record or import under a different id)');
    return result;
  }
  await ensureDir(destDir);

  // Character spec — verbatim copy for provenance alongside the record.
  await copyFile(specPath, join(destDir, 'character-spec.json'));
  result.files += 1;

  const hashExpectations = [];
  // Every file THIS run copied (dest-relative). Verification is scoped to
  // this set so a stale destination copy can't vouch for a file the current
  // source no longer provides.
  const copiedThisRun = new Set(['character-spec.json']);

  // reference/ — locked main + anchors; candidates/ (unapproved) stay behind.
  if (await pathExists(join(srcCharDir, 'reference'))) {
    const copied = await copyTree(
      join(srcCharDir, 'reference'),
      join(destDir, 'reference'),
      (rel, isDir) => !(isDir && basename(rel) === 'candidates') && !rel.includes('candidates/'),
    );
    result.files += copied.length;
    for (const rel of copied) copiedThisRun.add(`reference/${rel}`);
    for (const rel of copied) {
      if (!rel.endsWith('.json')) continue;
      const manifest = await readJson(join(destDir, 'reference', rel));
      for (const anchor of manifest?.anchors || []) {
        const anchorRel = relToCharacterDir(anchor?.path, characterId);
        if (anchorRel && anchor?.sha256) hashExpectations.push({ relPath: anchorRel, sha256: anchor.sha256 });
      }
    }
  }

  // walk/ — the manifests themselves are small provenance and copy whole,
  // but ASSETS import only for APPROVED directions of a FINALIZED set. Draft
  // selections / publication records / pending directions contribute nothing.
  const walkDir = join(srcCharDir, 'walk');
  if (await pathExists(walkDir)) {
    const copied = await copyTree(walkDir, join(destDir, 'walk'));
    result.files += copied.length;
    for (const rel of copied) copiedThisRun.add(`walk/${rel}`);
    for (const rel of copied) {
      if (!rel.endsWith('.json')) continue;
      const walkSet = await readJson(join(destDir, 'walk', rel));
      if (walkSet?.kind !== 'finalized-eight-direction-walk-set' || walkSet?.status !== 'final') continue;
      // The set's own top-level references (selectionPath/selectionSha256 …)
      // are hash-pinned provenance too. Harvest them from the metadata ONLY —
      // never from `directions`, or non-approved directions' run files would
      // ride in through the generic collector.
      const { directions, ...walkSetMeta } = walkSet;
      const metaRefs = new Set();
      collectManifestRefs(walkSetMeta, characterId, metaRefs, hashExpectations);
      for (const metaRel of [...metaRefs].sort()) {
        if (copiedThisRun.has(metaRel)) continue;
        if (await copyCharFile(srcCharDir, destDir, metaRel)) {
          result.files += 1;
          copiedThisRun.add(metaRel);
        } else result.errors.push(`walk set: referenced file missing: ${metaRel}`);
      }
      for (const [direction, dir] of Object.entries(directions || {})) {
        if (dir?.status !== 'approved') {
          result.errors.push(`walk set ${direction}: not approved (${dir?.status ?? 'missing'}) — skipped`);
          continue;
        }
        await importApprovedDirection({ srcCharDir, destDir, characterId, direction, dir, result, hashExpectations, copiedThisRun });
      }
    }
  }

  // runtime/ — immutable published atlas archives. (No wholesale imagegen/
  // copy: approved redraw outputs arrive via the walk-set expansion above;
  // the rest of imagegen/ is unselected candidates and raw intermediates.)
  if (await pathExists(join(srcCharDir, 'runtime'))) {
    const copied = await copyTree(join(srcCharDir, 'runtime'), join(destDir, 'runtime'));
    result.files += copied.length;
    for (const rel of copied) copiedThisRun.add(`runtime/${rel}`);
  }

  // Published-selection provenance: copy and hash-verify every character-dir
  // artifact the catalog's selection declares (immutable atlas archive, keyed
  // source, publication manifest, …) via the generic collector — pins ride in
  // through the {path,sha256} / <base>Path+<base>Sha256 conventions, and
  // repo-anchored references outside the character dir are ignored.
  if (selection?.characterId === characterId && selection.selected) {
    const selRefs = new Set();
    collectManifestRefs(selection.selected, characterId, selRefs, hashExpectations);
    for (const rel of [...selRefs].sort()) {
      if (copiedThisRun.has(rel)) continue;
      if (await copyCharFile(srcCharDir, destDir, rel)) {
        result.files += 1;
        copiedThisRun.add(rel);
      } else result.errors.push(`published selection: referenced asset missing: ${rel}`);
    }
  }

  result.verified = await verifyHashes(destDir, hashExpectations, result.errors, copiedThisRun);

  const record = await upsertImportedRecord(characterId, {
    kind: 'character',
    name: spec?.displayName || characterId,
    status: 'imported',
    spec,
    chromaKey: LEGACY_CHROMA_KEY,
    importedFrom: { sourceRoot, importedAt: new Date().toISOString() },
  });
  result.record = record;
  return result;
}

async function importPropsFamily({ sourceRoot, familyId, srcFamilyDir }) {
  const result = { id: familyId, kind: 'props', files: 0, verified: 0, errors: [] };
  const destDir = join(spriteDir(familyId), 'atlas');
  const copied = await copyTree(srcFamilyDir, destDir, (rel, isDir) => {
    if (isDir) return true;
    const lower = rel.toLowerCase();
    return PROP_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
  result.files += copied.length;
  const record = await upsertImportedRecord(familyId, {
    kind: 'props',
    name: familyId,
    status: 'imported',
    importedFrom: { sourceRoot, importedAt: new Date().toISOString() },
  });
  result.record = record;
  return result;
}

/**
 * Import approved sprite assets from `sourceRoot`. Options:
 *  - characters: limit to these character ids (default: all specs found)
 *  - includeProps: also import game/assets/sprites/ prop families (default true)
 *
 * Returns { results: [...perSubject], totals: { subjects, files, verified, errors } }.
 */
export async function importFromSource({ sourceRoot, characters, includeProps = true }) {
  // The UI placeholder suggests a ~/… path; resolve it before probing, or a
  // correct tilde path 400s with a misleading "not a sprite pipeline".
  sourceRoot = expandHome(sourceRoot);
  const specsDir = join(sourceRoot, 'art-pipeline', 'characters');
  const propsDir = join(sourceRoot, 'game', 'assets', 'sprites');
  const hasSpecs = await pathExists(specsDir);
  const hasProps = await pathExists(propsDir);
  if (!hasSpecs && !hasProps) {
    throw new ServerError(
      'Source root does not look like a sprite pipeline (expected art-pipeline/characters/ or game/assets/sprites/)',
      { status: 400, code: 'INVALID_SOURCE_ROOT' },
    );
  }

  await ensureDir(PATHS.sprites);
  // Read the published-selection pointer up front so the matching character's
  // import can verify the hash-pinned runtime artifacts it declares.
  const selection = await readJson(join(sourceRoot, 'art-pipeline', 'catalog', 'runtime-selection.json'));
  const results = [];
  // Ids imported THIS run (drives the runtime-selection provenance copy) vs
  // every character id the specs dir declares (drives the props-loop skip). A
  // filtered import must still exclude ALL characters' game dirs from the
  // props walk — otherwise `characters: ['a']` treats character b's published
  // atlas dir as a props family and overwrites b's record with kind:'props'.
  const characterIds = new Set();
  const allSpecCharacterIds = new Set();

  if (hasSpecs) {
    const wanted = Array.isArray(characters) && characters.length ? new Set(characters) : null;
    for (const entry of (await readdir(specsDir)).sort()) {
      if (!entry.endsWith('.json')) continue;
      const specPath = join(specsDir, entry);
      const spec = await readJson(specPath);
      // A real character spec carries characterId; sibling files in the specs
      // dir (JSON-schema definitions, templates) don't and are not subjects.
      if (!spec?.characterId) continue;
      const characterId = spec.characterId;
      if (!isValidSpriteId(characterId)) {
        results.push({ id: characterId, kind: 'character', files: 0, verified: 0, errors: ['invalid character id'] });
        continue;
      }
      allSpecCharacterIds.add(characterId);
      if (wanted && !wanted.has(characterId)) continue;
      characterIds.add(characterId);
      results.push(await importCharacter({ sourceRoot, characterId, spec, specPath, selection }));
    }
  }

  if (hasProps && includeProps) {
    for (const entry of (await readdir(propsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      // A character's published atlas dir duplicates what runtime/ archives —
      // only non-character families import from the game tree. Excludes every
      // spec-declared character, imported this run or not.
      if (allSpecCharacterIds.has(entry.name)) continue;
      if (!isValidSpriteId(entry.name)) continue;
      results.push(await importPropsFamily({ sourceRoot, familyId: entry.name, srcFamilyDir: join(propsDir, entry.name) }));
    }
  }

  // Published-atlas pointer — provenance for the current selection, kept with
  // the character it points at.
  if (selection?.characterId && characterIds.has(selection.characterId)) {
    const destDir = join(spriteDir(selection.characterId), 'catalog');
    await ensureDir(destDir);
    await atomicWrite(join(destDir, 'runtime-selection.json'), selection);
  }

  const totals = results.reduce(
    (acc, r) => ({
      subjects: acc.subjects + 1,
      files: acc.files + r.files,
      verified: acc.verified + r.verified,
      errors: acc.errors + r.errors.length,
    }),
    { subjects: 0, files: 0, verified: 0, errors: 0 },
  );
  console.log(`🎞️ Sprite import: ${totals.subjects} subjects, ${totals.files} files, ${totals.verified} hash-verified, ${totals.errors} errors`);
  return { results, totals };
}
