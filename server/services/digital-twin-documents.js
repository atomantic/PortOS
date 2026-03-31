import { readFile, writeFile, unlink, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { DIGITAL_TWIN_DIR, generateId, ensureSoulDir } from './digital-twin-helpers.js';
import { loadMeta, saveMeta } from './digital-twin-meta.js';
import { extractVersion } from './digital-twin-meta.js';

export async function getDocuments() {
  const meta = await loadMeta();
  const documents = [];

  for (const doc of meta.documents) {
    const filePath = join(DIGITAL_TWIN_DIR, doc.filename);
    const exists = existsSync(filePath);

    if (exists) {
      const stats = await stat(filePath);
      documents.push({
        ...doc,
        lastModified: stats.mtime.toISOString(),
        size: stats.size
      });
    }
  }

  return documents;
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

export async function createDocument(data) {
  await ensureSoulDir();

  const meta = await loadMeta();
  const filePath = join(DIGITAL_TWIN_DIR, data.filename);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Document ${data.filename} already exists`);
  }

  // Write the file
  await writeFile(filePath, data.content);

  // Add to meta
  const docMeta = {
    id: generateId(),
    filename: data.filename,
    title: data.title,
    category: data.category,
    version: extractVersion(data.content),
    enabled: data.enabled !== false,
    priority: data.priority || 50,
    weight: data.weight || 5
  };

  meta.documents.push(docMeta);
  meta.documents.sort((a, b) => a.priority - b.priority);
  await saveMeta(meta);

  console.log(`🧬 Created soul document: ${data.filename}`);
  return { ...docMeta, content: data.content };
}

export async function updateDocument(id, updates) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return null;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Update file content if provided
  if (updates.content) {
    await writeFile(filePath, updates.content);
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

  meta.documents[docIndex] = docMeta;
  await saveMeta(meta);

  console.log(`🧬 Updated soul document: ${docMeta.filename}`);
  return await getDocumentById(id);
}

export async function deleteDocument(id) {
  const meta = await loadMeta();
  const docIndex = meta.documents.findIndex(d => d.id === id);

  if (docIndex === -1) return false;

  const docMeta = meta.documents[docIndex];
  const filePath = join(DIGITAL_TWIN_DIR, docMeta.filename);

  // Delete file
  if (existsSync(filePath)) {
    await unlink(filePath);
  }

  // Remove from meta
  meta.documents.splice(docIndex, 1);
  await saveMeta(meta);

  console.log(`🧬 Deleted soul document: ${docMeta.filename}`);
  return true;
}
