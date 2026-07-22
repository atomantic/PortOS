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
 * Only approved/final artifacts import: reference candidates, raw video, and
 * extracted frame intermediates stay behind. Where a source manifest carries a
 * sha256 for a file, the copied bytes are verified against it — a mismatch is
 * recorded per-item (the import continues) so one corrupt file can't abort a
 * whole tree. Runs on demand only (a user action) — never at boot.
 */

import { join, basename, dirname } from 'path';
import { readdir, copyFile } from 'fs/promises';
import { PATHS, ensureDir, sha256File, atomicWrite, pathExists, readJSONFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { upsertImportedRecord } from './records.js';
import { spriteDir } from './paths.js';
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
 * Verify copied files against the sha256 map a source manifest declares.
 * `expectations` is [{ relPath, sha256 }] relative to destDir; missing files
 * and hash mismatches land in the returned errors list.
 */
async function verifyHashes(destDir, expectations, errors) {
  const outcomes = await Promise.all(
    expectations
      .filter(({ sha256 }) => typeof sha256 === 'string' && sha256)
      .map(async ({ relPath, sha256 }) => {
        const abs = join(destDir, relPath);
        if (!(await pathExists(abs))) return { error: `missing after copy: ${relPath}` };
        return (await sha256File(abs)) === sha256
          ? { verified: true }
          : { error: `sha256 mismatch: ${relPath}` };
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
  const marker = `sprites/${characterId}/`;
  const idx = manifestPath.indexOf(marker);
  const rel = idx >= 0 ? manifestPath.slice(idx + marker.length) : manifestPath.replace(/^\/+/, '');
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return rel;
}

async function importCharacter({ sourceRoot, characterId, spec, specPath }) {
  const result = { id: characterId, kind: 'character', files: 0, verified: 0, errors: [] };
  const srcCharDir = join(sourceRoot, 'art-source', 'sprites', characterId);
  const destDir = spriteDir(characterId);
  await ensureDir(destDir);

  // Character spec — verbatim copy for provenance alongside the record.
  await copyFile(specPath, join(destDir, 'character-spec.json'));
  result.files += 1;

  const hashExpectations = [];

  // reference/ — locked main + anchors; candidates/ (unapproved) stay behind.
  if (await pathExists(join(srcCharDir, 'reference'))) {
    const copied = await copyTree(
      join(srcCharDir, 'reference'),
      join(destDir, 'reference'),
      (rel, isDir) => !(isDir && basename(rel) === 'candidates') && !rel.includes('candidates/'),
    );
    result.files += copied.length;
    for (const rel of copied) {
      if (!rel.endsWith('.json')) continue;
      const manifest = await readJson(join(destDir, 'reference', rel));
      for (const anchor of manifest?.anchors || []) {
        const anchorRel = relToCharacterDir(anchor?.path, characterId);
        if (anchorRel && anchor?.sha256) hashExpectations.push({ relPath: anchorRel, sha256: anchor.sha256 });
      }
    }
  }

  // walk/ — finalized walk-set manifests, then the run files each direction
  // references (manifest + packed strip + previews; never raw/ or frames/).
  const walkDir = join(srcCharDir, 'walk');
  if (await pathExists(walkDir)) {
    const copied = await copyTree(walkDir, join(destDir, 'walk'));
    result.files += copied.length;
    for (const rel of copied) {
      if (!rel.endsWith('.json')) continue;
      const walkSet = await readJson(join(destDir, 'walk', rel));
      for (const [direction, dir] of Object.entries(walkSet?.directions || {})) {
        const runRel = relToCharacterDir(dir?.runPath, characterId);
        if (!runRel) {
          if (dir?.runPath) result.errors.push(`walk set ${direction}: unsafe run path rejected: ${dir.runPath}`);
          continue;
        }
        const srcRunDir = join(srcCharDir, runRel);
        if (!(await pathExists(srcRunDir))) {
          result.errors.push(`walk set references missing run: ${runRel}`);
          continue;
        }
        // Root-level files only — manifests, packed strips, previews. The
        // run's raw/, frames/, review/, generated/ intermediates stay behind.
        const runCopied = await copyTree(srcRunDir, join(destDir, runRel), (r, isDir) => !isDir && !r.includes('/'));
        result.files += runCopied.length;
        if (dir?.runManifest && dir?.runManifestSha256) {
          const manifestRel = relToCharacterDir(dir.runManifest, characterId);
          if (manifestRel) hashExpectations.push({ relPath: manifestRel, sha256: dir.runManifestSha256 });
        }
      }
    }
  }

  // runtime/ (immutable atlas archives) + imagegen/ (approved redraw sources).
  for (const sub of ['runtime', 'imagegen']) {
    if (await pathExists(join(srcCharDir, sub))) {
      const copied = await copyTree(join(srcCharDir, sub), join(destDir, sub));
      result.files += copied.length;
    }
  }

  result.verified = await verifyHashes(destDir, hashExpectations, result.errors);

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
  const results = [];
  const characterIds = new Set();

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
      if (wanted && !wanted.has(characterId)) continue;
      characterIds.add(characterId);
      results.push(await importCharacter({ sourceRoot, characterId, spec, specPath }));
    }
  }

  if (hasProps && includeProps) {
    for (const entry of (await readdir(propsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      // A character's published atlas dir duplicates what runtime/ archives —
      // only non-character families import from the game tree.
      if (characterIds.has(entry.name)) continue;
      if (!isValidSpriteId(entry.name)) continue;
      results.push(await importPropsFamily({ sourceRoot, familyId: entry.name, srcFamilyDir: join(propsDir, entry.name) }));
    }
  }

  // Published-atlas pointer — provenance for the current selection, kept with
  // the character it points at.
  const selection = await readJson(join(sourceRoot, 'art-pipeline', 'catalog', 'runtime-selection.json'));
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
