import { readFile, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { DIGITAL_TWIN_DIR, generateId, ensureSoulDir } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, withMetaLock } from './digital-twin-meta.js';
import { atomicWrite } from '../lib/fileUtils.js';
import { documentFilenameSchema } from '../lib/digitalTwinValidation.js';
import { isPathInsideDir } from '../lib/pathSafety.js';
import { ServerError } from '../lib/errorHandler.js';
import { extractVersion } from './digital-twin-meta.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { recordTombstone, clearTombstone, tombstoneTimestamp, supersedingTimestamp } from '../lib/tombstones.js';

// Legacy metadata may bypass schema parsing; reject individual bad records
// before any filename reaches the filesystem, without hiding valid neighbors.
const usableDocument = doc => doc && documentFilenameSchema.safeParse(doc.filename).success;
const documentRecords = meta => Array.isArray(meta.documents) ? meta.documents : [];

export async function getDocuments() {
  const meta = await loadMeta();
  const existing = documentRecords(meta).filter(usableDocument).filter(doc => existsSync(join(DIGITAL_TWIN_DIR, doc.filename)));
  const stats = await Promise.all(existing.map(doc => stat(join(DIGITAL_TWIN_DIR, doc.filename))));
  return existing.map((doc, i) => ({
    ...doc,
    lastModified: stats[i].mtime.toISOString(),
    size: stats[i].size
  }));
}

export async function getDocumentById(id) {
  const meta = await loadMeta();
  const docMeta = documentRecords(meta).find(d => usableDocument(d) && d.id === id);

  if (!docMeta) return null;

  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);
  if (!existsSync(filePath)) return null;

  const content = await readFile(filePath, 'utf-8');
  const stats = await stat(filePath);

  return {
    ...docMeta,
    content,
    lastModified: stats.mtime.toISOString(),
    size: stats.size
  };
}

// The document file and the meta row that names it are one workflow, so each
// mutation holds the backup lease from its first byte change through the meta
// write (#9982).
export const createDocument = (data) => withBackupAssetPublication(() => withMetaLock(() => createDocumentLeased(data)));
export const updateDocument = (id, updates) => withBackupAssetPublication(() => withMetaLock(() => updateDocumentLeased(id, updates)));
export const deleteDocument = (id) => withBackupAssetPublication(() => withMetaLock(() => deleteDocumentLeased(id)));

function documentWritePath(filename) {
  documentFilenameSchema.parse(filename);
  const filePath = resolve(DIGITAL_TWIN_DIR, filename);
  if (!isPathInsideDir(DIGITAL_TWIN_DIR, filePath)) {
    throw new ServerError('Invalid document destination', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return filePath;
}

async function createDocumentLeased(data) {
  // Validate before even creating the document directory or initializing metadata.
  const filePath = documentWritePath(data.filename);
  await ensureSoulDir();

  // loadMeta shares its cached object; publish these changes only after saveMeta succeeds.
  const meta = structuredClone(await loadMeta());

  // A file with no meta entry is an orphan from a failed earlier create; adopt it.
  const fileExisted = existsSync(filePath);
  if (fileExisted && documentRecords(meta).some(d => d?.filename === data.filename)) {
    throw new Error(`Document ${data.filename} already exists`);
  }

  await atomicWrite(filePath, data.content);

  // Re-creating a filename that was previously deleted must clear its tombstone
  // and stamp a creation time that STRICTLY supersedes the deletion — otherwise
  // a peer that still holds the old tombstone would reap the new document on the
  // next sync (#3530).
  const deletedAt = tombstoneTimestamp(meta.deletedDocuments, data.filename, 'filename');

  // Add to meta
  const docMeta = {
    id: generateId(),
    filename: data.filename,
    title: data.title,
    category: data.category,
    version: extractVersion(data.content),
    enabled: data.enabled !== false,
    priority: data.priority || 50,
    weight: data.weight || 5,
    createdAt: supersedingTimestamp(deletedAt)
  };

  meta.documents.push(docMeta);
  meta.documents.sort((a, b) => a.priority - b.priority);
  meta.deletedDocuments = clearTombstone(meta.deletedDocuments, data.filename, 'filename');
  // Remove only the file this attempt created; preserve a pre-existing orphan.
  await saveMeta(meta).catch(async (err) => {
    if (!fileExisted) await unlink(filePath).catch(() => {});
    throw err;
  });

  console.log(`🧬 Created soul document: ${data.filename}`);
  return { ...docMeta, content: data.content };
}

async function updateDocumentLeased(id, updates) {
  // loadMeta shares its cached object; publish these changes only after saveMeta succeeds.
  const meta = structuredClone(await loadMeta());
  const docIndex = documentRecords(meta).findIndex(d => usableDocument(d) && d.id === id);

  if (docIndex === -1) return null;

  const docMeta = meta.documents[docIndex];
  const filePath = documentWritePath(docMeta.filename);

  // Keep the previous body so a failed meta write can put it back. The new
  // bytes must not stay on disk under the old updatedAt: a peer tombstone newer
  // than that stamp would reap the edit (#3530, #14158).
  let previousContent = null;
  let wroteContent = false;
  if (updates.content) {
    if (existsSync(filePath)) previousContent = await readFile(filePath, 'utf-8');
    await atomicWrite(filePath, updates.content);
    wroteContent = true;
    docMeta.version = extractVersion(updates.content);
  }

  // Update metadata
  if (updates.title) docMeta.title = updates.title;
  if (updates.enabled !== undefined) docMeta.enabled = updates.enabled;
  if (updates.priority !== undefined) {
    docMeta.priority = updates.priority;
    // Sort the same objects in place. Writing docMeta back at the pre-sort
    // index would duplicate it and drop whichever document moved there.
    meta.documents.sort((a, b) => a.priority - b.priority);
  }
  if (updates.weight !== undefined) docMeta.weight = updates.weight;

  // Stamp the edit so a delete performed on ANOTHER machine before this edit
  // reached it can't reap the document and destroy the edit with it: the sync
  // merge keeps whichever of create/edit/delete happened last (#3530).
  docMeta.updatedAt = new Date().toISOString();

  await saveMeta(meta).catch(async (err) => {
    if (wroteContent) {
      if (previousContent === null) await unlink(filePath).catch(() => {});
      else {
        await atomicWrite(filePath, previousContent).catch((restoreErr) => {
          console.error(`❌ Digital twin document restore failed for ${docMeta.filename}: ${restoreErr.message}`);
        });
      }
    }
    throw err;
  });

  console.log(`🧬 Updated soul document: ${docMeta.filename}`);
  return await getDocumentById(id);
}

async function deleteDocumentLeased(id) {
  // loadMeta shares its cached object; publish these changes only after saveMeta succeeds.
  const meta = structuredClone(await loadMeta());
  const docIndex = documentRecords(meta).findIndex(d => usableDocument(d) && d.id === id);

  if (docIndex === -1) return false;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Tombstone before unlinking, same order as peer apply. A crash between them
  // leaves the delete durable; the leftover file is hidden because meta no
  // longer lists it, and reapTombstonedDocuments can remove it later (#14158).
  meta.documents.splice(docIndex, 1);
  meta.deletedDocuments = recordTombstone(meta.deletedDocuments, docMeta.filename, { keyField: 'filename' });
  await saveMeta(meta);

  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  console.log(`🧬 Deleted soul document: ${docMeta.filename}`);
  return true;
}
