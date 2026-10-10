import { readFile, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR, generateId, ensureSoulDir } from './digital-twin-helpers.js';
import { loadMeta, saveMeta, withMetaLock } from './digital-twin-meta.js';
import { atomicWrite } from '../lib/fileUtils.js';
import { extractVersion } from './digital-twin-meta.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { recordTombstone, clearTombstone, tombstoneTimestamp, supersedingTimestamp } from '../lib/tombstones.js';

export async function getDocuments() {
  const meta = await loadMeta();
  const existing = meta.documents.filter(doc => existsSync(join(DIGITAL_TWIN_DIR, doc.filename)));
  const stats = await Promise.all(existing.map(doc => stat(join(DIGITAL_TWIN_DIR, doc.filename))));
  return existing.map((doc, i) => ({
    ...doc,
    lastModified: stats[i].mtime.toISOString(),
    size: stats[i].size
  }));
}

export async function getDocumentById(id) {
  const meta = await loadMeta();
  const docMeta = meta.documents.find(d => d.id === id);

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

async function createDocumentLeased(data) {
  await ensureSoulDir();

  const meta = await loadMeta();
  const filePath = join(DIGITAL_TWIN_DIR, data.filename);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Document ${data.filename} already exists`);
  }

  // Write the file
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
  await saveMeta(meta);

  console.log(`🧬 Created soul document: ${data.filename}`);
  return { ...docMeta, content: data.content };
}

async function updateDocumentLeased(id, updates) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return null;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Update file content if provided
  if (updates.content) {
    await atomicWrite(filePath, updates.content);
    docMeta.version = extractVersion(updates.content);
  }

  // Update metadata
  if (updates.title) docMeta.title = updates.title;
  if (updates.enabled !== undefined) docMeta.enabled = updates.enabled;
  if (updates.priority !== undefined) {
    docMeta.priority = updates.priority;
    meta.documents.sort((a, b) => a.priority - b.priority);
  }
  if (updates.weight !== undefined) docMeta.weight = updates.weight;

  // Stamp the edit so a delete performed on ANOTHER machine before this edit
  // reached it can't reap the document and destroy the edit with it: the sync
  // merge keeps whichever of create/edit/delete happened last (#3530).
  docMeta.updatedAt = new Date().toISOString();

  meta.documents[docIndex] = docMeta;
  await saveMeta(meta);

  console.log(`🧬 Updated soul document: ${docMeta.filename}`);
  return await getDocumentById(id);
}

async function deleteDocumentLeased(id) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return false;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Delete file
  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  // Remove from meta and tombstone the filename so peer sync — which unions
  // documents add-only — can't resurrect it from a machine that still has the
  // file (#3530). The tombstone also propagates the delete to those peers.
  meta.documents.splice(docIndex, 1);
  meta.deletedDocuments = recordTombstone(meta.deletedDocuments, docMeta.filename, { keyField: 'filename' });
  await saveMeta(meta);

  console.log(`🧬 Deleted soul document: ${docMeta.filename}`);
  return true;
}
