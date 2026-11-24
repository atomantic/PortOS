import { createRequire } from 'node:module';
import { generatedCanvasPlaybackEngine } from './generatedCanvasPlayback.js';
import { generatedThreePlaybackEngine } from './generatedThreePlayback.js';
import { createHash } from 'node:crypto';
/**
 * Music Video — project composition documents (files on disk).
 *
 * A project in `composition.mode === 'document'` renders its own deterministic
 * HTML composition (a page exposing `globalThis.portosComposition`, see
 * services/htmlComposition). Every import writes one immutable version folder:
 *
 *   data/music-video/<projectId>/composition/<versionId>/index.html (+ scripts, fonts, media)
 *
 * and the record's `composition.document` points at it (data-relative path).
 * A clone carries the pointer and keeps reading the same bytes; a version no
 * live or tombstoned project points at is pruned after the next import. The
 * pointer is wire-local (lib/syncWire.js) because the files are not in the
 * project's peer-sync asset manifest; the folder is covered by the rsync
 * snapshot backup like the rest of data/music-video/.
 *
 * Storage: `asset-file-db-indexed` — immutable version folders, pointer on the
 * record. The pointer never federates, so a peer keeps its own and refuses to
 * render without one. Renders stage a job-private copy under
 * `data/music-video-song-renders/{jobId}/`, swept at boot and excluded from backups.
 *
 * Imports refuse symlinks, special files, traversal names and oversized trees
 * rather than rewriting them, so a document can never reach outside its folder.
 */

import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { readZipArchive, unsafeZipEntryName } from '../../lib/zipArchive.js';
import { createZip } from '../../lib/zipWriter.js';
import { listProjects, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { assertDocumentMediaPolicy } from './documentMediaPolicy.js';
import { normalizeComposition } from './composition.js';
import {
  collectTemplateFiles, collectTree, COMPATIBLE_IMAGE_EFFECT_MODULES, documentAvailable, documentsRoot,
  DOCUMENT_MAX_BYTES, DOCUMENT_MAX_FILES, DOCUMENT_ZIP_MAX_BYTES, engineDigest, isUpgradableLayeredEngine, LYRIC_TYPE_REF, LYRIC_TYPE_SCAN_MAX,
  refuse, requireDocument, resolveDocumentDirectory, SHARED_ROOT, STOCK_HELPERS, TEMPLATE_ROOT,
  UPGRADABLE_IMAGE_EFFECT_MODULES, withSharedImageEffects, withSharedLyricType,
} from './compositionDocumentRead.js';

export {
  availableDocumentDirectory, COMPATIBLE_IMAGE_EFFECT_MODULES, documentDirectoryForRender, documentMimeType,
  documentTemplateDirectory, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_FILES, DOCUMENT_ZIP_MAX_BYTES, isStaleShippedHelper,
  isUpgradableLayeredEngine, readDocumentFiles, readLyricOverlayDocumentFiles, readTemplateDocumentFiles,
  unsupportedDocumentEffects, UPGRADABLE_IMAGE_EFFECT_MODULES,
} from './compositionDocumentRead.js';

// Names the render writes next to the entry; a document may not ship them.
export const DOCUMENT_RESERVED_FILES = Object.freeze(['portos-mv.js', 'song.json']);

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const LAYERED_ENGINE_TAG = '<script src="engine.js"></script>';
const IMAGE_EFFECT_TAG = `<script type="module">
import { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers } from './musicVideoImageEffects.js';
globalThis.PORTOS_MV_IMAGE_EFFECTS = { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers };
</script><!-- portos-allow-hidden-content: shared still-image effect curves -->
`;
const LYRIC_TYPE_TAGS = '<link rel="stylesheet" href="lyricType.css">\n'
  + '<script type="module" src="lyricType.js"></script><!-- portos-allow-hidden-content: the shared PortOS lyric-type module -->\n';

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !SEGMENT.test(projectId)) throw refuse('Invalid project id', 'VALIDATION_ERROR', 400);
}

const projectDocumentRoot = (projectId) => join(documentsRoot(), projectId, 'composition');

// Reserved names are compared case-insensitively (macOS / Windows file systems).
const isReserved = (rel) => DOCUMENT_RESERVED_FILES.includes(rel.toLowerCase());

function assertDocumentShape(rels) {
  if (!rels.includes('index.html')) throw refuse('A composition document needs an index.html at its root', 'COMPOSITION_DOCUMENT_NO_ENTRY');
  const reserved = rels.find(isReserved);
  if (reserved) throw refuse(`${reserved} is written by PortOS at render time — remove it from the document`);
}

// Imports and detaches of one project run one at a time: a prune must never
// see a freshly renamed version folder whose record write is still pending.
const projectTails = new Map();
function serializeProject(projectId, task) {
  const previous = projectTails.get(projectId) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  projectTails.set(projectId, tail);
  tail.then(() => { if (projectTails.get(projectId) === tail) projectTails.delete(projectId); });
  return run;
}

/**
 * Write one immutable version folder from `files` ([{ rel, data } | { rel, abs }])
 * and point the project at it. The folder is assembled under a hidden name and
 * renamed into place, so a failed import never leaves a half-written version.
 */
function storeVersion(projectId, files, source, options = {}) {
  assertProjectId(projectId);
  return serializeProject(projectId, () => storeVersionNow(projectId, files, source, options));
}

/**
 * On explicit engine adoption, a template-shaped page gains the shared module
 * tags the current engine needs. Existing module tags and authored entrypoints
 * are preserved.
 */
function withLayeredModuleTags(page) {
  if (!page.includes(LAYERED_ENGINE_TAG)) return page;
  // Earlier shipped pages import fewer still-effect exports; widen them to the current set.
  page = page.replace(/import \{ imageEffectState, IMAGE_EFFECT_FOG_COLOR(?:, photoSequenceIndex)? \} from '\.\/musicVideoImageEffects\.js';/,
    "import { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers } from './musicVideoImageEffects.js';")
    .replace(/globalThis\.PORTOS_MV_IMAGE_EFFECTS = \{ imageEffectState, IMAGE_EFFECT_FOG_COLOR(?:, photoSequenceIndex)? \};/,
      'globalThis.PORTOS_MV_IMAGE_EFFECTS = { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers };');
  const tags = (LYRIC_TYPE_REF.test(page) ? '' : LYRIC_TYPE_TAGS)
    + (page.includes('PORTOS_MV_IMAGE_EFFECTS') ? '' : IMAGE_EFFECT_TAG);
  return page.replace(LAYERED_ENGINE_TAG, () => tags + LAYERED_ENGINE_TAG);
}

// Shared toon kit remains a local static graph, including its vendored geometry
// dependency. Authored copies win; unrelated documents gain no dependencies.
async function withSharedToonWorld(files) {
  let referenced = false;
  for (const file of files) {
    if (!/\.(?:html?|m?js)$/i.test(file.rel) || (file.size ?? file.data?.length ?? 0) > LYRIC_TYPE_SCAN_MAX) continue;
    const text = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
    if (/\btoonWorld\.js\b/.test(text)) { referenced = true; break; }
  }
  if (!referenced) return files;
  const rels = new Set(files.map(file => file.rel));
  const added = [];
  if (!rels.has('toonWorld.js')) added.push({ rel: 'toonWorld.js', data: await readFile(join(SHARED_ROOT, 'toonWorld.js')) });
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve('three')));
  for (const name of ['three.module.js', 'three.core.js', 'LICENSE']) {
    const rel = `vendor/${name}`;
    if (!rels.has(rel)) added.push({ rel, data: await readFile(join(packageRoot, name === 'LICENSE' ? name : `build/${name}`)) });
  }
  return [...files, ...added];
}

async function storeVersionNow(projectId, inputFiles, source, { draft = false, verifyCurrent = () => {} } = {}) {
  assertDocumentShape(inputFiles.map((file) => file.rel));
  const files = await withSharedToonWorld(await withSharedImageEffects(await withSharedLyricType(inputFiles)));
  const totalBytes = files.reduce((sum, file) => sum + (file.data?.length ?? file.size), 0);
  if (files.length > DOCUMENT_MAX_FILES || totalBytes > DOCUMENT_MAX_BYTES) {
    throw refuse('Shared document assets exceed the document file or byte limit', 'COMPOSITION_DOCUMENT_TOO_LARGE', 413);
  }
  const initial = await requireProject(projectId);
  await assertDocumentMediaPolicy(initial, files);
  const versionId = `doc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const root = projectDocumentRoot(projectId);
  const staging = join(root, `.${versionId}.partial`);
  const finalDir = join(root, versionId);
  let bytes = 0;
  try {
    for (const file of files) {
      const target = resolve(staging, file.rel);
      if (!isPathInsideDir(staging, target)) throw refuse(`Unsupported file name in the composition document (${file.rel})`);
      await mkdir(dirname(target), { recursive: true });
      if (file.data) await writeFile(target, file.data, { flag: 'wx' });
      else await cp(file.abs, target, { errorOnExist: true, force: false });
      bytes += file.data ? file.data.length : file.size;
    }
    await rename(staging, finalDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const document = {
    directory: `music-video/${projectId}/composition/${versionId}`,
    entry: 'index.html',
    updatedAt: new Date().toISOString(),
    source,
    files: files.length,
    bytes,
  };
  let outcome;
  try {
    // The version folder is already in place; the row that first names it
    // commits under a backup lease (#9982). Pruning removes only folders no
    // row names any more, so it needs none.
    outcome = await withBackupAssetPublication(() => mutateProjectRecord(projectId, (current) => {
      verifyCurrent(current);
      if (current.mediaMode !== initial.mediaMode) throw refuse('Media mode changed during import', 'COMPOSITION_DRAFT_STALE', 409);
      const composition = normalizeComposition({ ...(current.composition || {}), ...(!draft ? { mode: 'document' } : {}) });
      const project = { ...current, composition: { ...composition, [draft ? 'documentDraft' : 'document']: document }, updatedAt: document.updatedAt };
      return { project };
    }));
  } catch (error) {
    await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  console.log(`🧩 Music Video composition document ${versionId} stored for ${projectId.slice(0, 11)} (${files.length} files, ${source.kind})`);
  await pruneDocumentVersions(projectId).catch((err) => {
    console.warn(`⚠️ Music Video composition document prune failed for ${projectId.slice(0, 11)}: ${err.message}`);
  });
  return { project: outcome.project, document };
}

/**
 * Remove this project's version folders that no project (live or tombstoned —
 * a clone may share one) points at. Hidden `.partial` leftovers go too.
 */
async function pruneDocumentVersions(projectId) {
  assertProjectId(projectId);
  const root = projectDocumentRoot(projectId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (!entries.length) return 0;
  const referenced = new Set((await listProjects({ includeDeleted: true }))
    .flatMap((project) => [project?.composition?.document?.directory, project?.composition?.documentDraft?.directory]).filter(Boolean));
  let removed = 0;
  const staleBefore = Date.now() - 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // A hidden `.…partial` folder is an import in progress unless it is old.
    if (entry.name.startsWith('.')) {
      const info = await lstat(join(root, entry.name)).catch(() => null);
      if (!info || info.mtimeMs > staleBefore) continue;
    }
    if (referenced.has(`music-video/${projectId}/composition/${entry.name}`)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// A zip of a folder usually holds everything under one top-level directory.
function stripCommonRoot(names) {
  const first = names[0]?.split('/')[0];
  if (!first || names.includes('index.html')) return '';
  const prefix = `${first}/`;
  return names.every((name) => name.startsWith(prefix)) ? prefix : '';
}

/** Import an uploaded zip (the caller removes the temp file). */
export async function importDocumentZip(projectId, zipPath, originalName = null) {
  const info = await stat(zipPath);
  if (info.size > DOCUMENT_ZIP_MAX_BYTES) throw refuse('The zip is too large for a composition document', 'COMPOSITION_DOCUMENT_TOO_LARGE', 413);
  let entries;
  try {
    entries = readZipArchive(await readFile(zipPath), { maxEntries: DOCUMENT_MAX_FILES * 2 });
  } catch (error) {
    throw refuse(`Could not read the zip: ${error.message}`);
  }
  for (const entry of entries) {
    const problem = unsafeZipEntryName(entry.name);
    if (problem) throw refuse(`The zip has an unsafe member (${problem}): ${entry.name.slice(0, 120)}`, 'COMPOSITION_DOCUMENT_TRAVERSAL');
    if (entry.isSymlink) throw refuse(`Composition documents cannot contain symlinks (${entry.name.slice(0, 120)})`, 'COMPOSITION_DOCUMENT_SYMLINK');
  }
  const members = entries.filter((entry) => !entry.isDirectory && !entry.name.startsWith('__MACOSX/') && !entry.name.split('/').pop().startsWith('._'));
  const prefix = stripCommonRoot(members.map((entry) => entry.name));
  let bytes = 0;
  const files = members.map((entry) => {
    bytes += entry.size;
    if (members.length > DOCUMENT_MAX_FILES || bytes > DOCUMENT_MAX_BYTES) {
      throw refuse(`A composition document is limited to ${DOCUMENT_MAX_FILES} files and ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB`, 'COMPOSITION_DOCUMENT_TOO_LARGE', 413);
    }
    return { rel: entry.name.slice(prefix.length), entry };
  }).filter((file) => file.rel && !file.rel.split('/').pop().startsWith('.DS_Store'));
  // Read (inflate + CRC) only after every name passed.
  const loaded = files.map(({ rel, entry }) => {
    try { return { rel, data: entry.read() }; } catch (error) { throw refuse(`Could not read the zip: ${error.message}`); }
  });
  const name = typeof originalName === 'string' && originalName ? originalName.split(/[\\/]/).pop().slice(0, 200) : null;
  return storeVersion(projectId, loaded, { kind: 'zip', name });
}

/** Copy a document from a folder inside data/ given by its data-relative path. */
export async function importDocumentDirectory(projectId, directory) {
  const root = await realpath(PATHS.data);
  const requested = resolve(root, directory);
  const info = await lstat(requested).catch(() => null);
  if (!info) throw refuse('That folder does not exist inside data', 'COMPOSITION_DOCUMENT_NOT_FOUND', 404);
  if (info.isSymbolicLink()) throw refuse('The document folder must not be a symlink', 'COMPOSITION_DOCUMENT_SYMLINK');
  if (!info.isDirectory()) throw refuse('The document path must be a folder');
  // Every ancestor must resolve inside data too (a symlinked parent is refused).
  const real = await realpath(requested);
  const rel = relative(root, real);
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${sep}`) || real !== requested) {
    throw refuse('directory must be inside data and not reached through a symlink', 'COMPOSITION_DOCUMENT_SYMLINK');
  }
  const { files } = await collectTree(real);
  return storeVersion(projectId, files, { kind: 'directory', name: rel.split(sep).join('/').slice(0, 200) });
}

/** Copy a shipped template (documentTemplates/<id>) into the project. */
export async function importDocumentTemplate(projectId, templateId = 'layered') {
  const files = await collectTemplateFiles(templateId);
  return storeVersion(projectId, files, { kind: 'template', name: templateId });
}

/** Stage a host-assembled generated document for review before selection. */
export async function stageGeneratedDocument(projectId, generatedFiles, { verifyCurrent, renderer = 'canvas' } = {}) {
  if (renderer === 'three') {
    const { files } = await collectTree(join(TEMPLATE_ROOT, 'spatial'), { excludeTests: true });
    const originalEngine = await readFile(join(TEMPLATE_ROOT, 'spatial', 'engine.js'));
    const staged = files.filter(file => file.rel !== 'engine.js');
    staged.push({ rel: 'engine.js', data: generatedThreePlaybackEngine(originalEngine) },
      { rel: 'engine-reference.js', data: originalEngine },
      { rel: 'preview-playback.json', data: Buffer.from(JSON.stringify({ version: 1, contract: 'portos-complete-frame-v1' })) });
    const fonts = await collectTree(join(TEMPLATE_ROOT, 'layered', 'fonts'));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(dirname(require.resolve('three')));
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const dependencies = [];
    for (const name of ['build/three.module.js', 'build/three.core.js', 'LICENSE']) {
      const data = await readFile(join(packageRoot, name));
      const rel = `vendor/${name.split('/').pop()}`;
      staged.push({ rel, data });
      dependencies.push({ path: rel, sha256: createHash('sha256').update(data).digest('hex') });
    }
    staged.push(...fonts.files.map((file) => ({ ...file, rel: `fonts/${file.rel}` })), ...generatedFiles,
      { rel: 'dependencies.json', data: Buffer.from(JSON.stringify({ packages: [{ name: 'three', version: pkg.version, files: dependencies }], network: false })) });
    return storeVersion(projectId, staged, { kind: 'generated', name: 'Authored Three.js world' }, { draft: true, verifyCurrent });
  }
  const files = await collectTemplateFiles('layered');
  const index = await readFile(join(TEMPLATE_ROOT, 'layered', 'index.html'), 'utf8');
  const marker = '<script src="engine.js"></script>';
  if (!index.includes(marker)) throw new Error('Layered template has no engine script');
  const originalEngine = await readFile(join(TEMPLATE_ROOT, 'layered', 'engine.js'));
  const staged = files.filter((file) => file.rel !== 'index.html' && file.rel !== 'engine.js');
  staged.push({ rel: 'engine.js', data: generatedCanvasPlaybackEngine(originalEngine) },
    { rel: 'engine-reference.js', data: originalEngine },
    { rel: 'preview-playback.json', data: Buffer.from(JSON.stringify({ version: 1, contract: 'portos-complete-frame-v1' })) });
  staged.push({ rel: 'index.html', data: Buffer.from(index.replace(marker, '<script src="generated.js"></script>\n' + marker)) });
  staged.push(...generatedFiles);
  return storeVersion(projectId, staged, { kind: 'generated', name: 'Mixed-media composition' }, { draft: true, verifyCurrent });
}

/**
 * Helpers of a stock layered document that differ from the shipped ones:
 * `refresh` holds the shipped bytes for those that are an earlier shipped copy
 * (safe to replace), `custom` names those that are neither (authored; kept).
 * Only a template-shaped entrypoint is judged: an authored page may rely on its helpers' exact bytes.
 */
async function staleStockHelpers(files) {
  const refresh = new Map();
  const custom = [];
  const index = files.find(file => file.rel === 'index.html');
  const template = await readFile(join(TEMPLATE_ROOT, 'layered', 'index.html'), 'utf8');
  if (!index || engineDigest(withLayeredModuleTags(await readFile(index.abs, 'utf8'))) !== engineDigest(withLayeredModuleTags(template))) return { refresh, custom };
  for (const { rel, source, stale } of STOCK_HELPERS) {
    const file = files.find(entry => entry.rel === rel);
    if (!file) continue;
    const shipped = await readFile(source);
    const prior = await readFile(file.abs);
    if (engineDigest(prior) === engineDigest(shipped)) continue;
    if (stale.has(engineDigest(prior))) refresh.set(rel, shipped); else custom.push(rel);
  }
  return { refresh, custom };
}

function generatedLayeredEngineMatches(engine, reference) {
  if (!reference || !isUpgradableLayeredEngine(reference)) return false;
  try {
    // The first shipped generated Canvas wrapper used a different serialized
    // function name. Pin its exact bytes and its exact shipped reference.
    const firstGeneratedCanvas = engineDigest(reference) === 'ecf110208a0861eb35a39ca559997eca647b922b49c1ca5d5bddc35b2f37bd61'
      && createHash('sha256').update(engine).digest('hex') === 'ac67ea53b8007d974e941e1a311ff8b801696928c67cca664580a7485972748f';
    return firstGeneratedCanvas || engine.equals(generatedCanvasPlaybackEngine(reference));
  } catch { return false; }
}

/**
 * Explicitly adopt the shipped layered engine in a new immutable document.
 * All authored scripts, HTML, fonts and assets retain their exact bytes, except
 * that a template-shaped index.html gains the shared module tags the shipped
 * engine needs (see below). The
 * new pointer invalidates revision-bound render/review evidence naturally.
 */
export function upgradeDocumentEngine(projectId, directory) {
  assertProjectId(projectId);
  return serializeProject(projectId, async () => {
    const project = await requireProject(projectId);
    const verifyCurrent = current => {
      if (current.composition?.mode !== 'document' || current.composition?.document?.directory !== directory || current.composition?.documentDraft) {
        throw refuse('The selected document changed or has a pending candidate — finish it before upgrading', 'COMPOSITION_DRAFT_STALE', 409);
      }
    };
    verifyCurrent(project);
    const dir = await requireDocument(project);
    const { files } = await collectTree(dir);
    const engine = files.find(file => file.rel === 'engine.js');
    const shipped = await readFile(join(TEMPLATE_ROOT, 'layered', 'engine.js'));
    const prior = engine ? await readFile(engine.abs) : null;
    if (!prior) throw refuse('This document has no supported layered engine', 'COMPOSITION_ENGINE_CUSTOM', 409);
    const generated = project.composition.document.source?.kind === 'generated';
    const referenceFile = generated && files.find(file => file.rel === 'engine-reference.js');
    const reference = referenceFile ? await readFile(referenceFile.abs) : null;
    const nextEngine = generated && reference ? generatedCanvasPlaybackEngine(shipped) : shipped;
    const engineCurrent = engineDigest(prior) === engineDigest(nextEngine);
    // A current engine can still sit beside stale shipped helpers (they are what the preview compares).
    const { refresh, custom: customHelpers } = generated ? { refresh: new Map(), custom: [] } : await staleStockHelpers(files);
    if (engineCurrent && refresh.size === 0) return { project, document: project.composition.document, changed: false, customHelpers };
    if (!engineCurrent && (generated && reference ? !generatedLayeredEngineMatches(prior, reference) : !isUpgradableLayeredEngine(prior))) {
      throw refuse('The engine was customized or is not a supported shipped version — preserve it and revise it explicitly', 'COMPOSITION_ENGINE_CUSTOM', 409);
    }
    const imageEffects = files.find(file => file.rel === 'musicVideoImageEffects.js');
    const shippedImageEffects = await readFile(new URL('../../lib/musicVideo/musicVideoImageEffects.js', import.meta.url));
    if (imageEffects && !engineCurrent) {
      const digest = engineDigest(await readFile(imageEffects.abs));
      if (digest !== engineDigest(shippedImageEffects) && !UPGRADABLE_IMAGE_EFFECT_MODULES.has(digest) && !COMPATIBLE_IMAGE_EFFECT_MODULES.has(digest)) {
        throw refuse('The still-effect module was customized or is not a supported shipped version — preserve it and revise it explicitly before upgrading', 'COMPOSITION_ENGINE_CUSTOM', 409);
      }
    }
    const loaded = await Promise.all(files.map(async file => ({
      rel: file.rel, data: file.rel === 'engine.js' ? nextEngine
        : refresh.has(file.rel) ? refresh.get(file.rel)
        : generated && file.rel === 'engine-reference.js' ? shipped
        : file.rel === 'musicVideoImageEffects.js' && UPGRADABLE_IMAGE_EFFECT_MODULES.has(engineDigest(await readFile(file.abs)))
          ? shippedImageEffects : await readFile(file.abs),
    })));
    // Add the shared lyric-type and still-effect modules only to a template-shaped
    // page. storeVersionNow supplies missing module files and fonts; authored
    // entrypoints keep their bytes.
    const index = loaded.find(file => file.rel === 'index.html');
    if (index) index.data = Buffer.from(withLayeredModuleTags(index.data.toString('utf8')));
    const result = await storeVersionNow(projectId, loaded, project.composition.document.source || { kind: 'directory', name: null }, { verifyCurrent });
    return { ...result, changed: true, customHelpers };
  });
}

/** Select exactly the candidate the director reviewed. */
export function acceptGeneratedDocument(projectId, directory, { verifyCurrent = () => {} } = {}) {
  return serializeProject(projectId, async () => {
    const outcome = await mutateProjectRecord(projectId, (current) => {
      const draft = current.composition?.documentDraft;
      if (!draft || draft.directory !== directory || draft.source?.kind !== 'generated') {
        throw refuse('The composition candidate changed — review the latest version', 'COMPOSITION_DRAFT_STALE', 409);
      }
      verifyCurrent(current);
      const { documentDraft: _ignored, ...composition } = current.composition;
      return { project: { ...current, composition: { ...composition, mode: 'document', document: draft }, updatedAt: new Date().toISOString() } };
    });
    await pruneDocumentVersions(projectId);
    return { project: outcome.project, document: outcome.project.composition.document };
  });
}

/** Discard a candidate without replacing the active document. */
export function discardGeneratedDocument(projectId, directory) {
  return serializeProject(projectId, async () => {
    const outcome = await mutateProjectRecord(projectId, (current) => {
      if (current.composition?.documentDraft?.directory !== directory) {
        throw refuse('The composition candidate changed', 'COMPOSITION_DRAFT_STALE', 409);
      }
      const { documentDraft: _ignored, ...composition } = current.composition;
      return { project: { ...current, composition, updatedAt: new Date().toISOString() } };
    });
    await pruneDocumentVersions(projectId);
    return { project: outcome.project };
  });
}

/** The document's file list: `{ document, files: [{ path, bytes }], totalBytes }`. */
export async function readDocumentManifest(project) {
  const document = project?.composition?.document || null;
  if (!document) return { document: null, available: false, files: [], totalBytes: 0 };
  if (!(await documentAvailable(project))) return { document, available: false, files: [], totalBytes: 0 };
  const { files, bytes } = await collectTree(resolveDocumentDirectory(document));
  return {
    document,
    available: true,
    files: files.map((file) => ({ path: file.rel, bytes: file.size })).sort((a, b) => a.path.localeCompare(b.path)),
    totalBytes: bytes,
  };
}

/** A zip of the current document: `{ zip, filename }`. */
export async function exportDocumentZip(project) {
  const dir = await requireDocument(project);
  const { files } = await collectTree(dir);
  const entries = [];
  for (const file of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    entries.push({ name: file.rel, data: await readFile(file.abs) });
  }
  return { zip: createZip(entries, { compress: true }), filename: `music-video-${project.id}-composition.zip` };
}

/** Absolute path of one document file for the preview bridge, refusing traversal and symlinks. */
export async function resolveDocumentFile(project, relPath) {
  const dir = await requireDocument(project);
  if (unsafeZipEntryName(relPath)) throw refuse('Invalid document file path', 'VALIDATION_ERROR', 400);
  const abs = resolve(dir, relPath);
  if (!isPathInsideDir(dir, abs)) throw refuse('Invalid document file path', 'VALIDATION_ERROR', 400);
  const info = await lstat(abs).catch(() => null);
  if (!info?.isFile()) throw new ServerError('Document file not found', { status: 404, code: 'NOT_FOUND' });
  return abs;
}

/** Point the project back at no document (the folders are pruned). */
export function detachDocument(projectId) {
  assertProjectId(projectId);
  return serializeProject(projectId, async () => {
    const outcome = await mutateProjectRecord(projectId, (current) => {
      if (!current.composition?.document) return { project: current };
      const { document: _removed, ...composition } = current.composition;
      return { project: { ...current, composition, updatedAt: new Date().toISOString() } };
    });
    await pruneDocumentVersions(projectId).catch((err) => {
      console.warn(`⚠️ Music Video composition document prune failed for ${projectId.slice(0, 11)}: ${err.message}`);
    });
    return { project: outcome.project };
  });
}
