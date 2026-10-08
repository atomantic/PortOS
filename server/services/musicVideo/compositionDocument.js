import { createRequire } from 'node:module';
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
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { readZipArchive, unsafeZipEntryName } from '../../lib/zipArchive.js';
import { createZip } from '../../lib/zipWriter.js';
import { MUSIC_VIDEO_DOCUMENT_DIRECTORY, MUSIC_VIDEO_DOCUMENT_TEMPLATES } from '../../lib/musicVideoValidation.js';
import { getProject, listProjects, mutateProjectRecord } from './projects.js';
import { normalizeComposition } from './composition.js';

// The composition browser snapshots at most 256 MiB / 4096 files per render,
// and a render adds the staged scene media beside the document.
export const DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const DOCUMENT_MAX_FILES = 1024;
export const DOCUMENT_ZIP_MAX_BYTES = DOCUMENT_MAX_BYTES + 16 * 1024 * 1024;
// Names the render writes next to the entry; a document may not ship them.
export const DOCUMENT_RESERVED_FILES = Object.freeze(['portos-mv.js', 'song.json']);

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'documentTemplates');

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
async function collectTree(root) {
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

async function storeVersionNow(projectId, files, source, { draft = false, verifyCurrent = () => {} } = {}) {
  assertDocumentShape(files.map((file) => file.rel));
  const initial = await getProject(projectId);
  await assertDocumentMediaPolicy(initial, files);
  if (!initial) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
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
  const { files } = await collectTree(join(TEMPLATE_ROOT, templateId));
  return storeVersion(projectId, files, { kind: 'template', name: templateId });
}

/** Stage a host-assembled generated document for review before selection. */
export async function stageGeneratedDocument(projectId, generatedFiles, { verifyCurrent, renderer = 'canvas' } = {}) {
  if (renderer === 'three') {
    const { files } = await collectTree(join(TEMPLATE_ROOT, 'spatial'));
    const fonts = await collectTree(join(TEMPLATE_ROOT, 'layered', 'fonts'));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(dirname(require.resolve('three')));
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const dependencies = [];
    for (const name of ['build/three.module.js', 'build/three.core.js', 'LICENSE']) {
      const data = await readFile(join(packageRoot, name));
      const rel = `vendor/${name.split('/').pop()}`;
      files.push({ rel, data });
      dependencies.push({ path: rel, sha256: createHash('sha256').update(data).digest('hex') });
    }
    files.push(...fonts.files.map((file) => ({ ...file, rel: `fonts/${file.rel}` })), ...generatedFiles,
      { rel: 'dependencies.json', data: Buffer.from(JSON.stringify({ packages: [{ name: 'three', version: pkg.version, files: dependencies }], network: false })) });
    return storeVersion(projectId, files, { kind: 'generated', name: 'Authored Three.js world' }, { draft: true, verifyCurrent });
  }
  const { files } = await collectTree(join(TEMPLATE_ROOT, 'layered'));
  const index = await readFile(join(TEMPLATE_ROOT, 'layered', 'index.html'), 'utf8');
  const marker = '<script src="engine.js"></script>';
  if (!index.includes(marker)) throw new Error('Layered template has no engine script');
  const staged = files.filter((file) => file.rel !== 'index.html');
  staged.push({ rel: 'index.html', data: Buffer.from(index.replace(marker, '<script src="generated.js"></script>\n' + marker)) });
  staged.push(...generatedFiles);
  return storeVersion(projectId, staged, { kind: 'generated', name: 'Mixed-media composition' }, { draft: true, verifyCurrent });
}

// Known compatible shipped layered engines. Recognition only;
// customized engines belong to the author and are never silently replaced.
const UPGRADABLE_LAYERED_ENGINES = new Set([
  '2556a0905a85958b9107cfa75ab0c5bfde167a708e29b511d577065bb530ea58',
  'e2267a068c92a3c7dee49db5f3e57caff1ac11aee1312c0d82e28352850aad3b',
  '23842766a818fd9820d79ff229eab538cc0edf391992756cbfd14434d525c019',
  '5f69f39cfbdbf0531c23250d01773447529a5254271b0b77f40d029d02bb0e1f',
]);
const engineDigest = bytes => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n?/g, '\n')).digest('hex');

/**
 * Explicitly adopt the shipped layered engine in a new immutable document.
 * All authored scripts, HTML, fonts and assets retain their exact bytes. The
 * new pointer invalidates revision-bound render/review evidence naturally.
 */
export function upgradeDocumentEngine(projectId, directory) {
  assertProjectId(projectId);
  return serializeProject(projectId, async () => {
    const project = await getProject(projectId);
    const verifyCurrent = current => {
      if (current.composition?.mode !== 'document' || current.composition?.document?.directory !== directory || current.composition?.documentDraft) {
        throw refuse('The selected document changed or has a pending candidate — finish it before upgrading', 'COMPOSITION_DRAFT_STALE', 409);
      }
    };
    if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    verifyCurrent(project);
    const dir = await requireDocument(project);
    const { files } = await collectTree(dir);
    const engine = files.find(file => file.rel === 'engine.js');
    const shipped = await readFile(join(TEMPLATE_ROOT, 'layered', 'engine.js'));
    const prior = engine ? await readFile(engine.abs) : null;
    if (!prior) throw refuse('This document has no supported layered engine', 'COMPOSITION_ENGINE_CUSTOM', 409);
    if (engineDigest(prior) === engineDigest(shipped)) return { project, document: project.composition.document, changed: false };
    if (!UPGRADABLE_LAYERED_ENGINES.has(engineDigest(prior))) {
      throw refuse('The engine was customized or is not a supported shipped version — preserve it and revise it explicitly', 'COMPOSITION_ENGINE_CUSTOM', 409);
    }
    const loaded = await Promise.all(files.map(async file => ({
      rel: file.rel, data: file.rel === 'engine.js' ? shipped : await readFile(file.abs),
    })));
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
export async function documentDirectoryForRender(project) {
  await readDocumentFiles(project);
  const dir = await requireDocument(project);
  return relative(PATHS.data, dir).split(sep).join('/');
}

/** Every file a document ships, read into memory (the preview builder). */
export async function readDocumentFiles(project) {
  const dir = await requireDocument(project);
  const { files } = await collectTree(dir);
  await assertDocumentMediaPolicy(project, files);
  const out = new Map();
  for (const file of files) out.set(file.rel, { abs: file.abs, size: file.size });
  return out;
}
