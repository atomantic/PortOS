import { createRequire } from 'node:module';
import { generatedCanvasPlaybackEngine } from './generatedCanvasPlayback.js';
import { generatedThreePlaybackEngine } from './generatedThreePlayback.js';
import { createHash } from 'node:crypto';
import { assertDocumentMediaPolicy } from './documentMediaPolicy.js';
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
 * Imports refuse symlinks, special files, traversal names and oversized trees
 * rather than rewriting them, so a document can never reach outside its folder.
 */

import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isPathInsideDir, isTopLevelEntryName } from '../../lib/pathSafety.js';
import { readZipArchive, unsafeZipEntryName } from '../../lib/zipArchive.js';
import { createZip } from '../../lib/zipWriter.js';
import { MUSIC_VIDEO_DOCUMENT_DIRECTORY, MUSIC_VIDEO_DOCUMENT_TEMPLATES } from '../../lib/musicVideoValidation.js';
import { listProjects, mutateProjectRecord } from './projects.js';
import { requireProject } from './requireProject.js';
import { normalizeComposition } from './composition.js';
import { imageEffectState, isEndFrameImageEffect, sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideoImageEffects.js';
import { sceneImageEffectGlitchFrames, sceneTransitionSections, shotGlitchFrames, transitionGlitchFrames } from '../../lib/musicVideoTransitions.js';
import { wipeCuts } from '../../lib/musicVideoWipes.js';
import { documentSceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { documentRenderClock, documentSongDuration } from './documentTiming.js';

// The composition browser snapshots at most 256 MiB / 4096 files per render,
// and a render adds the staged scene media beside the document.
export const DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const DOCUMENT_MAX_FILES = 1024;
export const DOCUMENT_ZIP_MAX_BYTES = DOCUMENT_MAX_BYTES + 16 * 1024 * 1024;
// Names the render writes next to the entry; a document may not ship them.
export const DOCUMENT_RESERVED_FILES = Object.freeze(['portos-mv.js', 'song.json']);

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'documentTemplates');
// The shared kinetic lyric-type module (#10583): lyricType.js, lyricType.css and their OFL faces.
const SHARED_ROOT = join(TEMPLATE_ROOT, 'shared');
const LYRIC_TYPE_REF = /\blyricType\.(?:js|css)\b/;
const LYRIC_TYPE_SCAN_MAX = 2 * 1024 * 1024;
const LAYERED_ENGINE_TAG = '<script src="engine.js"></script>';
const IMAGE_EFFECT_TAG = `<script type="module">
import { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers } from './musicVideoImageEffects.js';
globalThis.PORTOS_MV_IMAGE_EFFECTS = { imageEffectState, IMAGE_EFFECT_FOG_COLOR, photoSequenceIndex, photoSequenceLayers };
</script><!-- portos-allow-hidden-content: shared still-image effect curves -->
`;
const LYRIC_TYPE_TAGS = '<link rel="stylesheet" href="lyricType.css">\n'
  + '<script type="module" src="lyricType.js"></script><!-- portos-allow-hidden-content: the shared PortOS lyric-type module -->\n';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
});

/** The served media type for a document file (octet-stream when unknown). */
export const documentMimeType = (path) => MIME_TYPES[extname(String(path)).toLowerCase()] || 'application/octet-stream';

const refuse = (message, code = 'COMPOSITION_DOCUMENT_INVALID', status = 422) => new ServerError(message, { status, code });

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !SEGMENT.test(projectId)) throw refuse('Invalid project id', 'VALIDATION_ERROR', 400);
}

const documentsRoot = () => join(PATHS.data, 'music-video');
const projectDocumentRoot = (projectId) => join(documentsRoot(), projectId, 'composition');

/**
 * Absolute folder for a stored document pointer, or null when the pointer is
 * not a version folder inside data/music-video/ (a hand-edited or peer record).
 */
function resolveDocumentDirectory(document) {
  const directory = document?.directory;
  if (typeof directory !== 'string' || !MUSIC_VIDEO_DOCUMENT_DIRECTORY.test(directory)) return null;
  const abs = resolve(PATHS.data, directory);
  return isPathInsideDir(documentsRoot(), abs) ? abs : null;
}

/** Whether the project has a document pointer whose folder holds an index.html on this install. */
async function documentAvailable(project) {
  const dir = resolveDocumentDirectory(project?.composition?.document);
  if (!dir) return false;
  const info = await lstat(join(dir, 'index.html')).catch(() => null);
  return Boolean(info?.isFile());
}

// Reserved names are compared case-insensitively (macOS / Windows file systems).
const isReserved = (rel) => DOCUMENT_RESERVED_FILES.includes(rel.toLowerCase());

/**
 * Every regular file under `root` as `[{ rel, abs, size }]`, refusing symlinks,
 * special files and a tree over the file / byte caps. `rel` uses `/`.
 */
async function collectTree(root, { excludeTests = false } = {}) {
  const files = [];
  let bytes = 0;
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      const abs = join(dir, entry.name);
      // lstat, not the dirent alone: a symlink is refused even when it points inside.
      const info = await lstat(abs);
      if (info.isSymbolicLink()) throw refuse(`Composition documents cannot contain symlinks (${rel})`, 'COMPOSITION_DOCUMENT_SYMLINK');
      if (info.isDirectory()) { await walk(abs, `${rel}/`); continue; }
      if (!info.isFile()) throw refuse(`Composition documents can only contain regular files (${rel})`);
      if (unsafeZipEntryName(rel)) throw refuse(`Unsupported file name in the composition document (${rel})`);
      if (excludeTests && rel.endsWith('.test.js')) continue;
      files.push({ rel, abs, size: info.size });
      bytes += info.size;
      if (files.length > DOCUMENT_MAX_FILES || bytes > DOCUMENT_MAX_BYTES) {
        throw refuse(`A composition document is limited to ${DOCUMENT_MAX_FILES} files and ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB`, 'COMPOSITION_DOCUMENT_TOO_LARGE', 413);
      }
    }
  }
  await walk(root, '');
  return { files, bytes };
}

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

/**
 * A document that references the shared lyric-type module (lyricType.js / .css)
 * without shipping it gets PortOS's copy and its faces added at its root, so an
 * uploaded document never renders without its type. Files the document ships
 * itself (its own lyricType.js, its own fonts) are kept as they are.
 */
async function withSharedLyricType(files) {
  const rels = new Set(files.map((file) => file.rel));
  let referenced = false;
  for (const file of files) {
    if (!/\.(?:html?|m?js|css)$/i.test(file.rel) || (file.size ?? file.data?.length ?? 0) > LYRIC_TYPE_SCAN_MAX) continue;
    const text = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
    if (LYRIC_TYPE_REF.test(text)) { referenced = true; break; }
  }
  if (!referenced) return files;
  const { files: shared } = await collectTree(SHARED_ROOT, { excludeTests: true });
  const missing = shared.filter((file) => file.rel !== 'toonWorld.js' && !rels.has(file.rel));
  return missing.length ? [...files, ...missing] : files;
}

// Ship the actual browser-safe effect definition, preserving an authored copy.
async function withSharedImageEffects(files) {
  if (files.some(file => file.rel === 'musicVideoImageEffects.js')) return files;
  for (const file of files) {
    if (!/\.(?:html?|m?js)$/i.test(file.rel) || (file.size ?? file.data?.length ?? 0) > LYRIC_TYPE_SCAN_MAX) continue;
    const text = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
    if (!/\bmusicVideoImageEffects\.js\b/.test(text)) continue;
    const abs = fileURLToPath(new URL('../../lib/musicVideoImageEffects.js', import.meta.url));
    return [...files, { rel: 'musicVideoImageEffects.js', abs, size: (await stat(abs)).size }];
  }
  return files;
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
  if (!MUSIC_VIDEO_DOCUMENT_TEMPLATES.includes(templateId)) throw refuse('Unknown composition template', 'VALIDATION_ERROR', 400);
  const { files } = await collectTree(join(TEMPLATE_ROOT, templateId), { excludeTests: true });
  return storeVersion(projectId, files, { kind: 'template', name: templateId });
}

/**
 * A shipped template's files as `readDocumentFiles` returns them, read in place
 * with the shared lyric-type module beside them, for a preview no project owns
 * (the lyric timing playthrough). Nothing is copied into the project.
 */
export async function readTemplateDocumentFiles(templateId = 'layered') {
  if (!MUSIC_VIDEO_DOCUMENT_TEMPLATES.includes(templateId)) throw refuse('Unknown composition template', 'VALIDATION_ERROR', 400);
  const { files } = await collectTree(join(TEMPLATE_ROOT, templateId), { excludeTests: true });
  return new Map((await withSharedImageEffects(await withSharedLyricType(files))).map((file) => [file.rel, { abs: file.abs, size: file.size }]));
}

/**
 * The storyboard animatic's lyric overlay page (documentTemplates/lyricOverlay),
 * read like `readTemplateDocumentFiles`: the words alone on a transparent frame.
 * It is not a template a project can pick.
 */
export async function readLyricOverlayDocumentFiles() {
  const { files } = await collectTree(join(TEMPLATE_ROOT, 'lyricOverlay'), { excludeTests: true });
  return new Map((await withSharedImageEffects(await withSharedLyricType(files))).map((file) => [file.rel, { abs: file.abs, size: file.size }]));
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
  const { files } = await collectTree(join(TEMPLATE_ROOT, 'layered'), { excludeTests: true });
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

// Known compatible shipped layered engines. Recognition only;
// customized engines belong to the author and are never silently replaced.
const UPGRADABLE_LAYERED_ENGINES = new Set([
  // Shipped before the handheld camera template additions.
  'a20bb2cf128153aada5c963baf8af22ca4a5ca72bda56d801b2d41a693cb606e',
  // Shipped before card painters honored beat-reaction controls (#15629).
  '4ee3ae7c78bce6d9dde36a1f2336c7bfd899918f359b6a9906b619c07a0bfb1b',
  // Shipped before per-video and per-shot template controls (#15622).
  'b45ad91d8def477e02761e4a2b61c4546b68a3e53cf5f4038fcaa30c9596bac8',
  // The shipped engine before shot color match (#15596).
  '106e8a140d76e7fa33734d24ec5ea90f57e8f5a21ba873e505edc49e80eb550e',
  // The shipped engine before cut wipes (#14831).
  'b5180a986424a2d6c15cde037baa72088ebf347e79e21b0e89f3c957936d1062',
  // The shipped engine before document end-frame and selected glitch effects.
  '0cc9d52c4bbf82cec93b418e41e7cfe49a89f6feb0602c02ecdee6f00f9cf307',
  // Shipped between still effects (#11319) and the later lyric-runtime check.
  '22d6cf739b607da221780f32524baeb70ae86ddf9f0a83d57b9a5462dd93b44a',
  'ecf110208a0861eb35a39ca559997eca647b922b49c1ca5d5bddc35b2f37bd61',
  '20fff73949a37d069f1de4cf2dab4d185049f799fe4bb129747cc3bf678d9e4f',
  // #14276's engine: one photo at a time, before overlapping photo stacks (#14277).
  '934ee8ca6b42f642bec05019c208e54369d063f06b521384d20d54b0b8e0900a',
  '2844a20f3d6ad57022e97ae79705a9296479ff5a59cdebeaa9e48246d3d7a086',
  // Last shipped engine before document still-image effects (#11319).
  '9581bb2d190e62ea2eb6a709bc989b1f913c501236554cd0301379877dc8a5fc',
  'dc27611ebaa429c28bd467b003495d2a1c7dc0ede73be0cfc28db4b97c964dcf',
  '2556a0905a85958b9107cfa75ab0c5bfde167a708e29b511d577065bb530ea58',
  'e2267a068c92a3c7dee49db5f3e57caff1ac11aee1312c0d82e28352850aad3b',
  '23842766a818fd9820d79ff229eab538cc0edf391992756cbfd14434d525c019',
  '5f69f39cfbdbf0531c23250d01773447529a5254271b0b77f40d029d02bb0e1f',
  // #10583's engine (shared lyricType.js), before cameraRig.js (#10589); an upgraded
  // copy without the rig script keeps a slow push.
  '02ca75c17c58eec1bb37463fdd187a133d8c10499bb2b6556c793af8d63b93e8',
]);
// Shipped still-effect modules a document may carry; adoption replaces them with the current one.
export const UPGRADABLE_IMAGE_EFFECT_MODULES = new Set([
  // #15571: still-effect module before honoring Use end frame (`endFrameOff`).
  // Commit 16f8de61cd (module-private photo layout normalizer).
  'bf072f2842ff71aa5b95da0a42c47b861b7d7e8d3c1759524907538ccc8f157a',
  // #11319's initial still-effect module.
  '4f13c0c26039cdecd0dab5450ebe702d49653e207594af07297ced8f21c2eb1e',
  'b771bf1da99500e14b751ffe82a95ddee749df2030d1a8be7c21b068a7def1e8',
  // #14276: photo sequences, before stacked layers (#14277).
  '6289528435cb4b9cd535679a6492a6ecd22258213fc5361db13ae301dfda3cde',
]);
// This shipped module already supplies the new engine's imports and also
// exposes an extra export. Keep its bytes for documents that may use it.
export const COMPATIBLE_IMAGE_EFFECT_MODULES = new Set([
  'b5905e6d5be37d5d8b1ed0a1c741e3f9813b65c70eec182a3a3cf86efd4ec92d',
]);
const engineDigest = bytes => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n?/g, '\n')).digest('hex');

/** Whether `engine` (engine.js bytes) is an older shipped layered engine that "Update layered engine" can replace. */
export const isUpgradableLayeredEngine = engine => UPGRADABLE_LAYERED_ENGINES.has(engineDigest(engine));

function generatedLayeredEngineMatches(engine, reference) {
  if (!reference || !UPGRADABLE_LAYERED_ENGINES.has(engineDigest(reference))) return false;
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
    if (engineDigest(prior) === engineDigest(nextEngine)) return { project, document: project.composition.document, changed: false };
    if (generated && reference ? !generatedLayeredEngineMatches(prior, reference) : !UPGRADABLE_LAYERED_ENGINES.has(engineDigest(prior))) {
      throw refuse('The engine was customized or is not a supported shipped version — preserve it and revise it explicitly', 'COMPOSITION_ENGINE_CUSTOM', 409);
    }
    const imageEffects = files.find(file => file.rel === 'musicVideoImageEffects.js');
    const shippedImageEffects = await readFile(new URL('../../lib/musicVideoImageEffects.js', import.meta.url));
    if (imageEffects) {
      const digest = engineDigest(await readFile(imageEffects.abs));
      if (digest !== engineDigest(shippedImageEffects) && !UPGRADABLE_IMAGE_EFFECT_MODULES.has(digest) && !COMPATIBLE_IMAGE_EFFECT_MODULES.has(digest)) {
        throw refuse('The still-effect module was customized or is not a supported shipped version — preserve it and revise it explicitly before upgrading', 'COMPOSITION_ENGINE_CUSTOM', 409);
      }
    }
    const loaded = await Promise.all(files.map(async file => ({
      rel: file.rel, data: file.rel === 'engine.js' ? nextEngine
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
    return { ...result, changed: true };
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

async function requireDocument(project) {
  const dir = resolveDocumentDirectory(project?.composition?.document);
  if (!dir || !(await documentAvailable(project))) {
    throw refuse('This project has no composition document on this machine — import one or start from the template', 'COMPOSITION_DOCUMENT_MISSING', 409);
  }
  return dir;
}

/**
 * Whether the project's composition document can play in the viewer's browser:
 * `{ native: true }` for the unmodified shipped layered template, else
 * `{ native: false, reason }`. Authored or customized documents stay in the
 * isolated preview worker.
 */
export async function documentNativePlayback(project) {
  if (project?.composition?.mode !== 'document' || !(await documentAvailable(project))) return { native: false, reason: 'no-document' };
  const { shippedLayeredDocument } = await import('./documentPreviewPlayback.js');
  const result = await shippedLayeredDocument(resolveDocumentDirectory(project.composition.document));
  if (!result.shipped) return { native: false, reason: result.reason };
  const { buildDocumentData, documentRenderClock, documentSongDuration, documentAspect, DOCUMENT_FRAME_SIZES } = await import('./documentRender.js');
  const durationSec = documentSongDuration(project);
  const data = buildDocumentData(project, {
    frame: DOCUMENT_FRAME_SIZES[documentAspect(project)], clock: documentRenderClock(durationSec, 24), songDurationSec: durationSec,
  });
  return { native: true, data };
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

/** The document folder a render stages; throws COMPOSITION_DOCUMENT_MISSING. */
export async function documentDirectoryForRender(project, { requireSelectedEffects = true } = {}) {
  await readDocumentFiles(project, { requireSelectedEffects });
  const dir = await requireDocument(project);
  return relative(PATHS.data, dir).split(sep).join('/');
}

const SELECTED_EFFECT_LABELS = { transition: 'glitch transitions', glitch: 'in-shot glitches', end: 'end-frame effects', wipe: 'wipes' };
// The `portos-selected-effects` level a document must declare to draw each kind: 2 adds wipes (#14831).
const SELECTED_EFFECT_LEVELS = { transition: 1, glitch: 1, end: 1, wipe: 2 };

const selectedEffectKinds = shots => Object.keys(SELECTED_EFFECT_LABELS)
  .filter(kind => shots.some(shot => shot.effects.includes(kind))).map(kind => SELECTED_EFFECT_LABELS[kind]);

// The highest `portos-selected-effects: N` an engine.js or index.html declares, 0 when none.
const declaredEffectsLevel = async files => {
  const declarations = files.filter(file => ['engine.js', 'index.html'].includes(file.rel));
  const levels = await Promise.all(declarations.map(async file =>
    Number(/^(?:\/\/ portos-selected-effects: (\d+)|<!-- portos-selected-effects: (\d+) -->)$/m.exec(await readFile(file.abs, 'utf8'))?.slice(1).find(Boolean) || 0)));
  return Math.max(0, ...levels);
};

// The shots with effects a document at `level` cannot draw, each naming only those effects.
const unsupportedAt = (shots, level) => shots
  .map(shot => ({ ...shot, effects: shot.effects.filter(kind => SELECTED_EFFECT_LEVELS[kind] > level) }))
  .filter(shot => shot.effects.length);

/**
 * The shots whose selected effects land inside the song and need an engine that
 * declares `portos-selected-effects`: `[{ sceneId, effects: ['transition'|'glitch'|'end'|'wipe'] }]`.
 * Each shot is checked with only its own effects so the list names the shots.
 */
function selectedEffectShots(project) {
  const scenes = project.scenes || [];
  const duration = documentSongDuration(project);
  const { fps, frames } = documentRenderClock(duration || 0);
  const sections = sceneTransitionSections(scenes, fps, { endSec: duration, cameras: project.cameras });
  const inSong = effect => effect.frame >= 0 && effect.frame < frames;
  const found = new Map();
  const add = (sceneId, kind) => {
    if (!found.has(sceneId)) found.set(sceneId, []);
    if (!found.get(sceneId).includes(kind)) found.get(sceneId).push(kind);
  };
  const bare = ({ transitionIn: _in, transitionOut: _out, wipeIn: _wipeIn, wipeOut: _wipeOut, ...section }) => section;
  for (const section of sections) {
    if ((section.transitionIn || section.transitionOut)
      && transitionGlitchFrames(sections.map(other => other === section ? other : bare(other)), { totalFrames: frames }).length > 0) add(section.sceneId, 'transition');
    if ((section.wipeIn || section.wipeOut) && wipeCuts(sections.map(other => other === section ? other : bare(other)), { fps }).length > 0) add(section.sceneId, 'wipe');
    if (section.shotGlitches && shotGlitchFrames([section], fps).some(inSong)) add(section.sceneId, 'glitch');
  }
  const generated = project.composition?.document?.source?.kind === 'generated';
  const imageExists = id => isTopLevelEntryName(id) && !id.includes('..') && existsSync(join(PATHS.images, id));
  const eligibleEnd = scenes.filter(scene => Number.isFinite(scene?.startSec) && scene?.visualLayer === 'still' && isEndFrameImageEffect(scene.imageEffect)
    && scene.endFrameOff !== true && scene.endImageId && documentSceneVisualLayer(project, scene, { generated }) === 'still').filter(scene => {
    const sequence = scenePhotoSequence(scene);
    return imageExists(scene.endImageId) && (sequence ? sequence.imageIds.length > 0 && sequence.imageIds.every(imageExists) : imageExists(scene.referenceImageId));
  });
  // The layered engine displays only valid intervals, using the latest valid
  // scene at an overlap. Its glitch overlay has a separate frame timeline.
  const layeredScenes = scenes.filter(scene => scene?.sceneId && Number.isFinite(scene.startSec)
    && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec).sort((a, b) => a.startSec - b.startSec);
  for (const scene of eligibleEnd) {
    const index = layeredScenes.indexOf(scene);
    const next = layeredScenes[index + 1];
    const lastFrame = index < 0 ? -1 : Math.min(frames, Math.ceil(scene.endSec * fps), next ? Math.ceil(next.startSec * fps) : frames) - 1;
    const visible = index >= 0 && lastFrame >= Math.max(0, Math.ceil(scene.startSec * fps)) && (() => {
      const state = imageEffectState(sceneImageEffect(scene, { layered: true }), (lastFrame - Math.round(scene.startSec * fps)) / fps, { fps });
      return state.end > 0 || state.flash > 0;
    })();
    if (visible || sceneImageEffectGlitchFrames(scenes.map(other => other === scene ? other : { ...other, imageEffect: null }),
      fps, { layered: true, endSec: duration, cameras: project.cameras }).some(inSong)) add(scene.sceneId, 'end');
  }
  return [...found].map(([sceneId, effects]) => ({ sceneId, effects }));
}

/**
 * Shots whose selected effects this document cannot draw (its engine predates
 * them): `[{ sceneId, effects }]`, empty when every effect is drawn. The live
 * preview plays without them and names them; renders refuse instead.
 */
export async function unsupportedDocumentEffects(project) {
  const { files } = await collectTree(await requireDocument(project));
  return unsupportedAt(selectedEffectShots(project), await declaredEffectsLevel(files));
}

/** Every file a document ships, read into memory (the preview builder). */
export async function readDocumentFiles(project, { requireLyricVisibility = true, requireSelectedEffects = true } = {}) {
  const dir = await requireDocument(project);
  const { files } = await collectTree(dir);
  await assertDocumentMediaPolicy(project, files);
  if (requireSelectedEffects) {
    const shots = unsupportedAt(selectedEffectShots(project), await declaredEffectsLevel(files));
    if (shots.length) throw new ServerError(`This composition does not declare support for the selected shot effects (${selectedEffectKinds(shots).join(', ')}). Update the layered engine under Document source, or add effect support to the custom document.`, {
      status: 422, code: 'DOCUMENT_SELECTED_EFFECTS_UNSUPPORTED',
    });
  }
  const sequences = (project.scenes || []).map(scene => scenePhotoSequence(scene)).filter(Boolean);
  if (sequences.length) {
    const engine = files.find(file => file.rel === 'engine.js');
    // Engine marker 1 plays one photo at a time; 2 also composes overlapping, laid-out photos (#14277).
    const level = engine ? Number(/^\/\/ portos-photo-sequence: (\d+)$/m.exec(await readFile(engine.abs, 'utf8'))?.[1] || 0) : 0;
    const needed = sequences.some(sequence => sequence.stacked) ? 2 : 1;
    if (level < needed) throw new ServerError(needed > 1
      ? 'Update the composition playback engine to support overlapping photo layers before previewing or rendering.'
      : 'Update the composition playback engine to support photo sequences before previewing or rendering.', {
      status: 422, code: 'DOCUMENT_PHOTO_SEQUENCE_UNSUPPORTED',
    });
  }
  // Immutable documents retain their own runtime. Refuse an unsupported lyric
  // pass instead of claiming this project preference changed its output.
  if (requireLyricVisibility && project.lyricOverlayEnabled === false) {
    const runtimes = files.filter((file) => ['lyricType.js', 'engine.js'].includes(file.rel));
    const marked = await Promise.all(runtimes.map(async (file) =>
      /^\/\/ portos-lyric-overlay-visibility: 1$/m.test(await readFile(file.abs, 'utf8'))));
    if (!marked.length || !marked.every(Boolean)) {
      throw new ServerError('Update the document lyric renderer to support automatic lyric overlays being disabled before rendering. Authored text remains independent.', {
        status: 422, code: 'DOCUMENT_LYRIC_VISIBILITY_UNSUPPORTED',
      });
    }
  }
  const out = new Map();
  for (const file of files) out.set(file.rel, { abs: file.abs, size: file.size });
  return out;
}
